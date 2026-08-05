import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  extractWorkFile,
  importGeneratedImage,
  inspectWorkFile,
  MAX_WORK_FILE_BYTES,
  WorkFileError,
} from "../src/media/files.js";
import {
  NATIVE_BOUNDARY_THRESHOLD_BYTES,
  NATIVE_FAILURE_COOLDOWN_MS,
  NATIVE_LARGE_THRESHOLD_BYTES,
  NATIVE_MESSAGE_RETRY_DELAY_MS,
  NATIVE_SUCCESS_COOLDOWN_MS,
  nativeQueueContextRefreshSatisfied,
  nativeQueueFailureCircuitUntil,
  nativeQueueMessageRefreshBlocks,
  nativeQueueOpensCircuit,
  nativeQueueOpensMessageCircuit,
  nativeQueueInitialAttemptAt,
  nativeQueueNextDelay,
} from "../src/media/native-queue.js";
import { runCommand } from "../src/ops/process.js";

const projectRoot = process.env.WECHAT_CLAWBOT_ROOT ?? "/opt/WeChat-Open in";
const dataDir = process.env.WECHAT_CLAWBOT_DATA ?? path.join(projectRoot, "data");
const socketPath = process.env.WECHAT_MEDIA_SOCKET ?? path.join(dataDir, "run", "media-bridge.sock");
const expectedAccount = process.env.WECHAT_MEDIA_ACCOUNT_ID?.trim() ?? "";
if (!expectedAccount) throw new Error("WECHAT_MEDIA_ACCOUNT_ID is required");
const mediaBudgetBytes = 768 * 1024 * 1024;
const credentialDirectory = process.env.CREDENTIALS_DIRECTORY ?? (() => {
  throw new Error("systemd credential directory is required");
})();

const token = (await readFile(path.join(credentialDirectory, "broker-token"), "utf8")).trim();
if (token.length < 24) throw new Error("media bridge token is missing or too short");
const expectedOwner = (await readFile(path.join(credentialDirectory, "owner-wechat-id"), "utf8")).trim();
if (!expectedOwner || expectedOwner.length > 256 || /[\u0000-\u001f]/.test(expectedOwner)) {
  throw new Error("media bridge owner credential is missing or invalid");
}

const allowedRoots = [
  path.join(dataDir, "workspace"),
  path.join(dataDir, "state", "agents", "main", "agent", "codex-home", "generated_images"),
  path.join(dataDir, "state", "media", "inbound"),
];
const generatedImagesRoot = path.join(dataDir, "state", "agents", "main", "agent", "codex-home", "generated_images");
const importedImagesRoot = path.join(dataDir, "workspace", "media", "outbound", "imported-generated");
const weixinDisplayRoot = path.join(dataDir, "workspace", "media", "outbound", "weixin-display");
const WEIXIN_DISPLAY_MAX_BYTES = 220 * 1024;
const nativeSenderScript = path.join(projectRoot, "scripts", "send-native-attachment.mjs");
const weixinContextFile = path.join(
  dataDir,
  "state",
  "openclaw-weixin",
  "accounts",
  `${expectedAccount}.context-tokens.json`,
);
const initialContextMtimeMs = Math.trunc(
  (await stat(weixinContextFile).catch(() => undefined))?.mtimeMs ?? 0,
);

await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
await mkdir(path.join(dataDir, "state"), { recursive: true, mode: 0o750 });
const existingSocket = await lstat(socketPath).catch(() => null);
if (existingSocket) {
  if (!existingSocket.isSocket()) throw new Error(`refusing to replace non-socket path: ${socketPath}`);
  await rm(socketPath);
}

const db = new DatabaseSync(path.join(dataDir, "state", "media-bridge.sqlite"));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS deliveries (
    transfer_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    safe_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','failed','object_ready','link_sent','succeeded')),
    object_key TEXT,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    link_sent_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS deliveries_recovery_idx ON deliveries(state, updated_at);
`);
const deliveryColumns = new Set(
  (db.prepare("PRAGMA table_info(deliveries)").all() as unknown as Array<{ name: string }>)
    .map((column) => column.name),
);
for (const migration of [
  ["caption", "ALTER TABLE deliveries ADD COLUMN caption TEXT NOT NULL DEFAULT ''"],
  ["queued", "ALTER TABLE deliveries ADD COLUMN queued INTEGER NOT NULL DEFAULT 0"],
  ["attempt_count", "ALTER TABLE deliveries ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0"],
  ["next_attempt_at", "ALTER TABLE deliveries ADD COLUMN next_attempt_at INTEGER"],
  ["last_attempt_at", "ALTER TABLE deliveries ADD COLUMN last_attempt_at INTEGER"],
  ["worker_started_at", "ALTER TABLE deliveries ADD COLUMN worker_started_at INTEGER"],
] as const) {
  if (!deliveryColumns.has(migration[0])) db.exec(migration[1]);
}
db.prepare(`
  UPDATE deliveries
  SET next_attempt_at=MIN(next_attempt_at, updated_at + ?)
  WHERE queued=1 AND state='pending' AND size>=?
    AND error_code IS NOT NULL AND error_code<>'WEIXIN_SEND_FAILED'
    AND next_attempt_at IS NOT NULL
`).run(60 * 60_000, NATIVE_BOUNDARY_THRESHOLD_BYTES);
db.exec(`
  CREATE INDEX IF NOT EXISTS deliveries_native_queue_idx
  ON deliveries(queued, state, next_attempt_at, created_at);
  CREATE TABLE IF NOT EXISTS media_runtime_state (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
`);
db.prepare(`
  INSERT INTO media_runtime_state(key, value)
  SELECT 'large_circuit_until', COALESCE(MAX(updated_at + ?), 0)
  FROM deliveries
  WHERE queued=1 AND state='pending'
    AND size>=?
    AND size<?
    AND error_code IS NOT NULL AND error_code<>'WEIXIN_SEND_FAILED'
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`).run(
  NATIVE_FAILURE_COOLDOWN_MS,
  NATIVE_LARGE_THRESHOLD_BYTES,
  NATIVE_BOUNDARY_THRESHOLD_BYTES,
);
db.prepare(`
  INSERT INTO media_runtime_state(key, value)
  SELECT 'boundary_circuit_until', COALESCE(MAX(updated_at + ?), 0)
  FROM deliveries
  WHERE queued=1 AND state='pending' AND size>=?
    AND error_code IS NOT NULL AND error_code<>'WEIXIN_SEND_FAILED'
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`).run(NATIVE_FAILURE_COOLDOWN_MS, NATIVE_BOUNDARY_THRESHOLD_BYTES);
db.prepare(`
  INSERT OR IGNORE INTO media_runtime_state(key, value)
  SELECT 'message_refresh_after_context_mtime_ms',
         CASE WHEN EXISTS (
           SELECT 1 FROM deliveries
           WHERE queued=1 AND state='pending' AND error_code='WEIXIN_SEND_FAILED'
         ) THEN ? ELSE 0 END
`).run(initialContextMtimeMs);
db.prepare(`
  UPDATE deliveries
  SET next_attempt_at=MIN(next_attempt_at, ?), updated_at=?
  WHERE queued=1 AND state='pending' AND error_code='WEIXIN_SEND_FAILED'
    AND next_attempt_at IS NOT NULL
`).run(Date.now() + NATIVE_MESSAGE_RETRY_DELAY_MS, Date.now());
db.exec(`
  INSERT INTO media_runtime_state(key, value)
  SELECT 'message_circuit_until', COALESCE(MAX(next_attempt_at), 0)
  FROM deliveries
  WHERE queued=1 AND state='pending' AND error_code='WEIXIN_SEND_FAILED'
  ON CONFLICT(key) DO UPDATE SET value=excluded.value;
`);
const recoveredWorkerAt = Math.max(
  Date.now(),
  ...(
    db.prepare("SELECT value FROM media_runtime_state").all() as unknown as Array<{ value: number }>
  ).map((entry) => entry.value),
);
db.prepare(`
  UPDATE deliveries
  SET worker_started_at=NULL, next_attempt_at=COALESCE(next_attempt_at, ?), updated_at=?
  WHERE queued=1 AND state='pending' AND worker_started_at IS NOT NULL
`).run(recoveredWorkerAt, Date.now());

interface DeliveryRow {
  transfer_id: string;
  account_id: string;
  source_path: string;
  safe_name: string;
  mime: string;
  size: number;
  sha256: string;
  state: "pending" | "failed" | "object_ready" | "link_sent" | "succeeded";
  object_key: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
  link_sent_at: number | null;
  caption: string;
  queued: number;
  attempt_count: number;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  worker_started_at: number | null;
}

function audit(event: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ level: "info", event, at: new Date().toISOString(), ...details })}\n`);
}

function errorCode(error: unknown): string {
  if (error instanceof WorkFileError) return error.code;
  const text = String(error);
  if (/timeout/i.test(text)) return "TIMEOUT";
  return "INTERNAL_ERROR";
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

function authorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(provided); const right = Buffer.from(token);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage, maxBytes = 128 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw as Uint8Array);
    size += chunk.length;
    if (size > maxBytes) throw new WorkFileError("REQUEST_TOO_LARGE", "media bridge request exceeded its size limit");
    chunks.push(chunk);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkFileError("INVALID_REQUEST", "JSON object required");
  return parsed as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, name: string, maxLength = 4096): string {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\u0000")) {
    throw new WorkFileError("INVALID_REQUEST", `${name} is invalid`);
  }
  return value;
}

function transferId(body: Record<string, unknown>): string {
  const value = requiredString(body, "transferId", 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new WorkFileError("INVALID_TRANSFER_ID", "transferId must be a UUID");
  }
  return value;
}

function row(id: string): DeliveryRow {
  const value = db.prepare("SELECT * FROM deliveries WHERE transfer_id = ?").get(id) as DeliveryRow | undefined;
  if (!value) throw new WorkFileError("NOT_FOUND", "media transfer was not found");
  return value;
}

function deliveryStatus(body: Record<string, unknown>): Record<string, unknown> {
  const reference = requiredString(body, "transferId", 36).toLowerCase();
  if (!/^[0-9a-f]{8}(?:[0-9a-f-]{0,28})$/.test(reference)) {
    throw new WorkFileError("INVALID_TRANSFER_ID", "transferId must be a UUID or an 8+ character transfer prefix");
  }
  const matches = db.prepare(
    "SELECT * FROM deliveries WHERE lower(transfer_id) LIKE ? ORDER BY created_at DESC LIMIT 2",
  ).all(`${reference}%`) as unknown as DeliveryRow[];
  if (matches.length === 0) throw new WorkFileError("NOT_FOUND", "media transfer was not found");
  if (matches.length > 1) throw new WorkFileError("AMBIGUOUS_TRANSFER_ID", "media transfer prefix is ambiguous");
  const value = matches[0]!;
  return {
    transferId: value.transfer_id,
    state: value.state,
    errorCode: value.error_code,
    file: {
      name: value.safe_name,
      mime: value.mime,
      size: value.size,
      sha256: value.sha256,
    },
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    attempts: value.attempt_count,
    nextAttemptAt: value.next_attempt_at,
    queued: value.queued === 1,
  };
}

function activeDelivery(body: Record<string, unknown>): Record<string, unknown> {
  const accountId = requiredString(body, "accountId", 128);
  if (accountId !== expectedAccount) throw new WorkFileError("ACCOUNT_MISMATCH", "media account is not allowlisted");
  const sha256 = requiredString(body, "sha256", 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new WorkFileError("INVALID_REQUEST", "sha256 is invalid");
  const value = db.prepare(`
    SELECT * FROM deliveries
    WHERE account_id=? AND sha256=? AND state='pending' AND queued=1
    ORDER BY created_at ASC LIMIT 1
  `).get(accountId, sha256) as DeliveryRow | undefined;
  return value
    ? {
        found: true,
        transferId: value.transfer_id,
        state: value.state,
        attempts: value.attempt_count,
        nextAttemptAt: value.next_attempt_at,
      }
    : { found: false };
}

function enqueueDelivery(body: Record<string, unknown>): Record<string, unknown> {
  const id = transferId(body);
  const value = row(id);
  if (value.state === "succeeded") {
    return { transferId: id, state: value.state, duplicate: true };
  }
  if (value.state !== "pending") {
    throw new WorkFileError("TRANSFER_NOT_PENDING", "only a pending transfer can be queued");
  }
  const captionValue = body.caption;
  if (captionValue !== undefined && (
    typeof captionValue !== "string"
    || captionValue.length > 1000
    || captionValue.includes("\u0000")
  )) {
    throw new WorkFileError("INVALID_REQUEST", "caption is invalid");
  }
  const duplicate = db.prepare(`
    SELECT * FROM deliveries
    WHERE account_id=? AND sha256=? AND state='pending' AND queued=1 AND transfer_id<>?
    ORDER BY created_at ASC LIMIT 1
  `).get(value.account_id, value.sha256, id) as DeliveryRow | undefined;
  if (duplicate) {
    db.prepare(`
      UPDATE deliveries
      SET state='failed', error_code='DUPLICATE_TRANSFER', updated_at=?
      WHERE transfer_id=?
    `).run(Date.now(), id);
    return {
      transferId: duplicate.transfer_id,
      state: duplicate.state,
      duplicate: true,
      attempts: duplicate.attempt_count,
      nextAttemptAt: duplicate.next_attempt_at,
    };
  }
  const now = Date.now();
  const nextAttemptAt = Math.max(
    nativeQueueInitialAttemptAt(
      value.size,
      now,
      largeCircuitUntil(),
      boundaryCircuitUntil(),
    ),
    messageCircuitUntil(),
  );
  db.prepare(`
    UPDATE deliveries
    SET caption=?, queued=1, error_code=NULL, next_attempt_at=?, updated_at=?
    WHERE transfer_id=?
  `).run(captionValue ?? "", nextAttemptAt, now, id);
  audit("media.native_queued", {
    transferId: id,
    size: value.size,
    sha256: value.sha256.slice(0, 12),
  });
  wakeNativeWorker();
  return {
    transferId: id,
    state: "pending",
    duplicate: false,
    attempts: value.attempt_count,
    nextAttemptAt,
  };
}

let nativeWorkerRunning = false;
let nativeWorkerTimer: NodeJS.Timeout | undefined;
let nativeWorkerChild: ChildProcess | undefined;

function largeCircuitUntil(): number {
  const value = db.prepare(
    "SELECT value FROM media_runtime_state WHERE key='large_circuit_until'",
  ).get() as { value: number } | undefined;
  return value?.value ?? 0;
}

function setLargeCircuitUntil(value: number): void {
  db.prepare(`
    INSERT INTO media_runtime_state(key, value) VALUES ('large_circuit_until', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(Math.max(0, Math.trunc(value)));
}

function boundaryCircuitUntil(): number {
  const value = db.prepare(
    "SELECT value FROM media_runtime_state WHERE key='boundary_circuit_until'",
  ).get() as { value: number } | undefined;
  return value?.value ?? 0;
}

function setBoundaryCircuitUntil(value: number): void {
  db.prepare(`
    INSERT INTO media_runtime_state(key, value) VALUES ('boundary_circuit_until', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(Math.max(0, Math.trunc(value)));
}

function messageCircuitUntil(): number {
  const value = db.prepare(
    "SELECT value FROM media_runtime_state WHERE key='message_circuit_until'",
  ).get() as { value: number } | undefined;
  return value?.value ?? 0;
}

function setMessageCircuitUntil(value: number): void {
  db.prepare(`
    INSERT INTO media_runtime_state(key, value) VALUES ('message_circuit_until', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(Math.max(0, Math.trunc(value)));
}

function messageRefreshAfterContextMtimeMs(): number {
  const value = db.prepare(
    "SELECT value FROM media_runtime_state WHERE key='message_refresh_after_context_mtime_ms'",
  ).get() as { value: number } | undefined;
  return value?.value ?? 0;
}

function setMessageRefreshAfterContextMtimeMs(value: number): void {
  db.prepare(`
    INSERT INTO media_runtime_state(key, value)
    VALUES ('message_refresh_after_context_mtime_ms', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(Math.max(0, Math.trunc(value)));
}

function boundedPush(chunks: Buffer[], chunk: Buffer, currentBytes: number, limit = 128 * 1024): number {
  if (currentBytes >= limit) return currentBytes;
  const bounded = chunk.subarray(0, limit - currentBytes);
  chunks.push(bounded);
  return currentBytes + bounded.length;
}

async function runNativeSender(value: DeliveryRow): Promise<{ success: boolean; errorCode?: string }> {
  return await new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawn(process.execPath, [
      nativeSenderScript,
      value.source_path,
      // The persistent worker deliberately sends only the attachment.
      // Any caption or queue acknowledgement spends the same Tencent
      // sendmessage allowance and can prevent the attachment being accepted.
      "",
    ], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CREDENTIALS_DIRECTORY: credentialDirectory,
        MEDIA_BRIDGE_SOCKET: socketPath,
        MEDIA_BRIDGE_TOKEN_FILE: path.join(credentialDirectory, "broker-token"),
        WEIXIN_CDN_PRIMARY_METHOD: process.env.WEIXIN_CDN_PRIMARY_METHOD ?? "POST",
        WEIXIN_CDN_PRIMARY_URL_SOURCE: process.env.WEIXIN_CDN_PRIMARY_URL_SOURCE ?? "full",
        ...(process.env.WEIXIN_CDN_SOCKS_PROXY
          ? { WEIXIN_CDN_SOCKS_PROXY: process.env.WEIXIN_CDN_SOCKS_PROXY }
          : {}),
        WEIXIN_TRANSFER_ID: value.transfer_id,
        WEIXIN_MANAGED_DELIVERY: "1",
        WEIXIN_MAX_UPLOAD_ATTEMPTS: "1",
        WEIXIN_QUEUE_ATTEMPT: String(value.attempt_count),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    nativeWorkerChild = child;
    child.stdout?.on("data", (raw: Buffer) => {
      stdoutBytes = boundedPush(stdoutChunks, Buffer.from(raw), stdoutBytes);
    });
    child.stderr?.on("data", (raw: Buffer) => {
      stderrBytes = boundedPush(stderrChunks, Buffer.from(raw), stderrBytes);
    });
    child.once("error", (error) => {
      nativeWorkerChild = undefined;
      resolve({ success: false, errorCode: /ENOENT/.test(String(error)) ? "WORKER_UNAVAILABLE" : "PLATFORM_SEND_FAILED" });
    });
    child.once("close", (code) => {
      nativeWorkerChild = undefined;
      if (code === 0) {
        resolve({ success: true });
        return;
      }
      const combined = `${Buffer.concat(stdoutChunks).toString("utf8")}\n${Buffer.concat(stderrChunks).toString("utf8")}`;
      const match = combined.match(/"errorCode":"([A-Z0-9_]{1,64})"/);
      resolve({ success: false, errorCode: match?.[1] ?? "PLATFORM_SEND_FAILED" });
    });
  });
}

function nextQueuedDelivery(now = Date.now()): DeliveryRow | undefined {
  if (nativeQueueMessageRefreshBlocks(messageRefreshAfterContextMtimeMs())) return undefined;
  if (now < messageCircuitUntil()) return undefined;
  const largeCircuitOpen = now < largeCircuitUntil();
  const boundaryCircuitOpen = now < boundaryCircuitUntil();
  return db.prepare(`
    SELECT * FROM deliveries
    WHERE queued=1 AND state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)
      AND (?=0 OR size<?)
      AND (?=0 OR size<?)
    ORDER BY size, COALESCE(next_attempt_at, 0), created_at
    LIMIT 1
  `).get(
    now,
    largeCircuitOpen ? 1 : 0,
    NATIVE_LARGE_THRESHOLD_BYTES,
    boundaryCircuitOpen ? 1 : 0,
    NATIVE_BOUNDARY_THRESHOLD_BYTES,
  ) as DeliveryRow | undefined;
}

function millisecondsUntilNextDelivery(now = Date.now()): number {
  if (nativeQueueMessageRefreshBlocks(messageRefreshAfterContextMtimeMs())) return 60_000;
  if (now < messageCircuitUntil()) {
    return Math.max(1_000, Math.min(60_000, messageCircuitUntil() - now));
  }
  const small = db.prepare(`
    SELECT MIN(next_attempt_at) AS next_at
    FROM deliveries
    WHERE queued=1 AND state='pending' AND size<? AND next_attempt_at>?
  `).get(NATIVE_LARGE_THRESHOLD_BYTES, now) as { next_at: number | null };
  const large = db.prepare(`
    SELECT MIN(COALESCE(next_attempt_at, ?)) AS next_at
    FROM deliveries
    WHERE queued=1 AND state='pending' AND size>=? AND size<?
  `).get(
    now,
    NATIVE_LARGE_THRESHOLD_BYTES,
    NATIVE_BOUNDARY_THRESHOLD_BYTES,
  ) as { next_at: number | null };
  const boundary = db.prepare(`
    SELECT MIN(COALESCE(next_attempt_at, ?)) AS next_at
    FROM deliveries WHERE queued=1 AND state='pending' AND size>=?
  `).get(now, NATIVE_BOUNDARY_THRESHOLD_BYTES) as { next_at: number | null };
  const candidates = [
    small.next_at,
    large.next_at === null ? null : Math.max(large.next_at, largeCircuitUntil()),
    boundary.next_at === null
      ? null
      : Math.max(
          boundary.next_at,
          largeCircuitUntil(),
          boundaryCircuitUntil(),
        ),
  ].filter((value): value is number => value !== null && value > now);
  const nextAt = candidates.length > 0 ? Math.min(...candidates) : null;
  return nextAt === null ? 60_000 : Math.max(1_000, Math.min(60_000, nextAt - now));
}

function wakeNativeWorker(delayMs = 0): void {
  if (nativeWorkerTimer) clearTimeout(nativeWorkerTimer);
  nativeWorkerTimer = setTimeout(() => {
    nativeWorkerTimer = undefined;
    void runNativeWorker();
  }, delayMs);
  nativeWorkerTimer.unref();
}

let contextPollRunning = false;
let contextMtimeMs = initialContextMtimeMs;
const contextPollTimer = setInterval(() => {
  if (contextPollRunning) return;
  contextPollRunning = true;
  void (async () => {
    const current = await stat(weixinContextFile).catch(() => undefined);
    if (!current) return;
    const currentMtimeMs = Math.trunc(current.mtimeMs);
    const requiredAfterMtimeMs = messageRefreshAfterContextMtimeMs();
    const refreshRequirementSatisfied = nativeQueueContextRefreshSatisfied(
      requiredAfterMtimeMs,
      currentMtimeMs,
    );
    if (currentMtimeMs <= contextMtimeMs && !refreshRequirementSatisfied) return;
    contextMtimeMs = Math.max(contextMtimeMs, currentMtimeMs);
    const now = Date.now();
    const previousCircuitUntil = messageCircuitUntil();
    if (refreshRequirementSatisfied) setMessageRefreshAfterContextMtimeMs(0);
    if (previousCircuitUntil <= now && !refreshRequirementSatisfied) return;
    setMessageCircuitUntil(0);
    db.prepare(`
      UPDATE deliveries
      SET next_attempt_at=MIN(COALESCE(next_attempt_at, ?), ?), updated_at=?
      WHERE queued=1 AND state='pending' AND error_code='WEIXIN_SEND_FAILED'
    `).run(now, now, now);
    audit("media.message_circuit_released_by_inbound", {
      previousCircuitUntil,
      refreshRequirementSatisfied,
    });
    wakeNativeWorker();
  })().finally(() => {
    contextPollRunning = false;
  });
}, 1_000);
contextPollTimer.unref();

async function runNativeWorker(): Promise<void> {
  if (nativeWorkerRunning) return;
  const value = nextQueuedDelivery();
  if (!value) {
    wakeNativeWorker(millisecondsUntilNextDelivery());
    return;
  }
  nativeWorkerRunning = true;
  const now = Date.now();
  const attempt = value.attempt_count + 1;
  db.prepare(`
    UPDATE deliveries
    SET attempt_count=?, last_attempt_at=?, worker_started_at=?, next_attempt_at=NULL, updated_at=?
    WHERE transfer_id=?
  `).run(attempt, now, now, now, value.transfer_id);
  audit("media.native_worker_started", {
    transferId: value.transfer_id,
    attempt,
    size: value.size,
    sha256: value.sha256.slice(0, 12),
  });
  try {
    const result = await runNativeSender({ ...value, attempt_count: attempt });
    const finishedAt = Date.now();
    if (result.success) {
      db.prepare(`
        UPDATE deliveries
        SET state='succeeded', queued=0, error_code=NULL, next_attempt_at=NULL,
            worker_started_at=NULL, updated_at=?
        WHERE transfer_id=?
      `).run(finishedAt, value.transfer_id);
      if (value.size >= NATIVE_BOUNDARY_THRESHOLD_BYTES) {
        setBoundaryCircuitUntil(0);
      }
      if (value.size >= NATIVE_LARGE_THRESHOLD_BYTES) {
        setLargeCircuitUntil(finishedAt + NATIVE_SUCCESS_COOLDOWN_MS);
      }
      setMessageCircuitUntil(0);
      setMessageRefreshAfterContextMtimeMs(0);
      audit("media.native_succeeded", { transferId: value.transfer_id, attempt });
    } else {
      const error = normalizeFailure(result.errorCode);
      const retryDelay = nativeQueueNextDelay(value.size, attempt, error);
      if (retryDelay !== undefined) {
        const nextAttemptAt = finishedAt + retryDelay;
        const circuitUntil = nativeQueueFailureCircuitUntil(finishedAt);
        if (value.size >= NATIVE_LARGE_THRESHOLD_BYTES && nativeQueueOpensCircuit(error)) {
          if (value.size >= NATIVE_BOUNDARY_THRESHOLD_BYTES) {
            setBoundaryCircuitUntil(circuitUntil);
          } else {
            setLargeCircuitUntil(circuitUntil);
          }
        }
        if (nativeQueueOpensMessageCircuit(error)) {
          setMessageCircuitUntil(nextAttemptAt);
          const context = await stat(weixinContextFile).catch(() => undefined);
          setMessageRefreshAfterContextMtimeMs(
            Math.trunc(context?.mtimeMs ?? contextMtimeMs),
          );
        }
        db.prepare(`
          UPDATE deliveries
          SET state='pending', queued=1, error_code=?, next_attempt_at=?,
              worker_started_at=NULL, updated_at=?
          WHERE transfer_id=?
        `).run(error, nextAttemptAt, finishedAt, value.transfer_id);
        audit("media.native_retry_scheduled", {
          transferId: value.transfer_id,
          attempt,
          errorCode: error,
          delayMs: retryDelay,
          nextAttemptAt,
          circuitUntil,
        });
      } else {
        db.prepare(`
          UPDATE deliveries
          SET state='failed', queued=0, error_code=?, next_attempt_at=NULL,
              worker_started_at=NULL, updated_at=?
          WHERE transfer_id=?
        `).run(error, finishedAt, value.transfer_id);
        if (value.size >= NATIVE_BOUNDARY_THRESHOLD_BYTES) {
          setBoundaryCircuitUntil(0);
        } else if (value.size >= NATIVE_LARGE_THRESHOLD_BYTES) {
          setLargeCircuitUntil(0);
        }
        if (nativeQueueOpensMessageCircuit(error)) {
          setMessageCircuitUntil(finishedAt + NATIVE_MESSAGE_RETRY_DELAY_MS);
          const context = await stat(weixinContextFile).catch(() => undefined);
          setMessageRefreshAfterContextMtimeMs(
            Math.trunc(context?.mtimeMs ?? contextMtimeMs),
          );
        }
        audit("media.native_failed", { transferId: value.transfer_id, attempt, errorCode: error });
      }
    }
  } finally {
    nativeWorkerRunning = false;
    wakeNativeWorker(nextQueuedDelivery() ? 0 : millisecondsUntilNextDelivery());
  }
}

function publicFile(file: Awaited<ReturnType<typeof inspectWorkFile>>): Record<string, unknown> {
  return {
    name: file.safeName,
    mime: file.mime,
    size: file.size,
    sha256: file.sha256,
    quarantined: file.quarantined,
    ...(file.archiveEntries === undefined ? {} : { archiveEntries: file.archiveEntries, archiveUncompressedBytes: file.archiveUncompressedBytes }),
  };
}

async function treeBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += await treeBytes(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

async function mediaUsageBytes(): Promise<number> {
  let total = 0;
  for (const root of [
    path.join(dataDir, "cache", "media"),
    path.join(dataDir, "state", "media", "inbound"),
    path.join(dataDir, "workspace", "media", "inbound"),
    path.join(dataDir, "state", "agents", "main", "agent", "codex-home", "generated_images"),
    path.join(dataDir, "quarantine"),
  ]) total += await treeBytes(root);
  return total;
}

async function registerDelivery(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = transferId(body);
  const accountId = requiredString(body, "accountId", 128);
  if (accountId !== expectedAccount) throw new WorkFileError("ACCOUNT_MISMATCH", "media account is not allowlisted");
  if (await mediaUsageBytes() >= mediaBudgetBytes * 0.95) {
    throw new WorkFileError("MEDIA_CACHE_CRITICAL", "media cache is above 95%; new attachments are temporarily read-only");
  }
  const file = await inspectWorkFile(requiredString(body, "path", 8192), { allowedRoots, maxBytes: MAX_WORK_FILE_BYTES });
  const existing = db.prepare("SELECT * FROM deliveries WHERE transfer_id = ?").get(id) as DeliveryRow | undefined;
  if (existing) {
    if (existing.sha256 !== file.sha256 || existing.source_path !== file.realPath || existing.account_id !== accountId) {
      throw new WorkFileError("TRANSFER_CONFLICT", "transfer id is already bound to different immutable content");
    }
    return { transferId: id, state: existing.state, file: publicFile(file) };
  }
  const now = Date.now();
  db.prepare(`INSERT INTO deliveries
    (transfer_id, account_id, source_path, safe_name, mime, size, sha256, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(id, accountId, file.realPath, file.safeName, file.mime, file.size, file.sha256, now, now);
  audit("media.registered", { transferId: id, type: file.extension, size: file.size, sha256: file.sha256.slice(0, 12) });
  return { transferId: id, state: "pending", file: publicFile(file) };
}

async function prepareWeixinDisplayImage(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const source = await inspectWorkFile(requiredString(body, "path", 8192), {
    allowedRoots,
    maxBytes: MAX_WORK_FILE_BYTES,
  });
  if (!source.mime.startsWith("image/")) {
    throw new WorkFileError("IMAGE_REQUIRED", "WeChat display rendering accepts images only");
  }
  if (source.size <= WEIXIN_DISPLAY_MAX_BYTES) {
    return { path: source.realPath, file: publicFile(source), converted: false };
  }
  await mkdir(weixinDisplayRoot, { recursive: true, mode: 0o750 });
  const variants = [
    { width: 1280, quality: 82 },
    { width: 1200, quality: 74 },
    { width: 1024, quality: 68 },
  ];
  for (const variant of variants) {
    const target = path.join(
      weixinDisplayRoot,
      `${source.sha256.slice(0, 24)}-${variant.width}q${variant.quality}.jpg`,
    );
    const existing = await stat(target).catch(() => undefined);
    if (existing?.isFile() && existing.size <= WEIXIN_DISPLAY_MAX_BYTES) {
      const inspected = await inspectWorkFile(target, { allowedRoots, maxBytes: WEIXIN_DISPLAY_MAX_BYTES });
      return { path: inspected.realPath, file: publicFile(inspected), converted: true };
    }
    const temporary = path.join(weixinDisplayRoot, `.${randomUUID()}.jpg`);
    try {
      const converted = await runCommand([
        "/usr/bin/convert",
        `${source.realPath}[0]`,
        "-auto-orient",
        "-resize", `${variant.width}x${variant.width}>`,
        "-background", "white",
        "-alpha", "remove",
        "-alpha", "off",
        "-sampling-factor", "4:2:0",
        "-strip",
        "-interlace", "Plane",
        "-quality", String(variant.quality),
        temporary,
      ], { timeoutMs: 120_000, maxOutputBytes: 32 * 1024 });
      if (converted.code !== 0 || converted.timedOut) {
        throw new WorkFileError("IMAGE_CONVERSION_FAILED", "unable to render the WeChat display image");
      }
      const output = await stat(temporary);
      if (output.size > WEIXIN_DISPLAY_MAX_BYTES) continue;
      await rename(temporary, target);
      const inspected = await inspectWorkFile(target, { allowedRoots, maxBytes: WEIXIN_DISPLAY_MAX_BYTES });
      audit("media.weixin_display_created", {
        type: inspected.extension,
        size: inspected.size,
        sha256: inspected.sha256.slice(0, 12),
        sourceSha256: source.sha256.slice(0, 12),
      });
      return { path: inspected.realPath, file: publicFile(inspected), converted: true };
    } finally {
      await rm(temporary, { force: true });
    }
  }
  throw new WorkFileError("WEIXIN_DISPLAY_TOO_LARGE", "unable to fit the image within the tested WeChat display limit");
}

function normalizeFailure(value: unknown): string {
  const code = typeof value === "string" ? value.toUpperCase() : "PLATFORM_SEND_FAILED";
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "PLATFORM_SEND_FAILED";
}

function completeDelivery(body: Record<string, unknown>): Record<string, unknown> {
  const id = transferId(body);
  row(id);
  const success = body.success === true;
  const now = Date.now();
  if (success) {
    db.prepare(`
      UPDATE deliveries
      SET state='succeeded', queued=0, error_code=NULL, next_attempt_at=NULL,
          worker_started_at=NULL, updated_at=?
      WHERE transfer_id=?
    `).run(now, id);
    audit("media.native_succeeded", { transferId: id });
    return { transferId: id, state: "succeeded" };
  }
  const failure = normalizeFailure(body.errorCode);
  db.prepare(`
    UPDATE deliveries
    SET state='failed', queued=0, error_code=?, next_attempt_at=NULL,
        worker_started_at=NULL, updated_at=?
    WHERE transfer_id=? AND state!='succeeded'
  `).run(failure, now, id);
  audit("media.native_failed", { transferId: id, errorCode: failure });
  return { transferId: id, state: "failed", errorCode: failure };
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ok: true, deliveryMode: "native-only" });
    return;
  }
  if (!authorized(request)) { sendJson(response, 401, { error: { code: "UNAUTHORIZED", message: "unauthorized" } }); return; }
  if (request.method !== "POST") { sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }); return; }
  const body = await readJson(request);
  if (request.url === "/v1/files/inspect") {
    const file = await inspectWorkFile(requiredString(body, "path", 8192), { allowedRoots, maxBytes: MAX_WORK_FILE_BYTES });
    sendJson(response, 200, { ok: true, file: publicFile(file) }); return;
  }
  if (request.url === "/v1/files/import-generated") {
    const imported = await importGeneratedImage(requiredString(body, "path", 8192), {
      generatedRoot: generatedImagesRoot,
      destinationRoot: importedImagesRoot,
      ...(typeof body.name === "string" ? { name: requiredString(body, "name", 180) } : {}),
    });
    audit("media.generated_image_imported", {
      type: imported.file.extension,
      size: imported.file.size,
      sha256: imported.file.sha256.slice(0, 12),
      reused: imported.reused,
    });
    sendJson(response, 200, {
      ok: true,
      path: imported.path,
      file: publicFile(imported.file),
      reused: imported.reused,
    });
    return;
  }
  if (request.url === "/v1/files/prepare-weixin-image") {
    sendJson(response, 200, { ok: true, ...(await prepareWeixinDisplayImage(body)) }); return;
  }
  if (request.url === "/v1/files/extract") {
    const extracted = await extractWorkFile(requiredString(body, "path", 8192), {
      allowedRoots,
      ...(typeof body.sheet === "string" ? { sheet: body.sheet } : {}),
      ...(typeof body.cellRange === "string" ? { cellRange: body.cellRange } : {}),
      ...(typeof body.slides === "string" ? { slides: body.slides } : {}),
      ...(typeof body.maxChars === "number" ? { maxChars: body.maxChars } : {}),
    });
    sendJson(response, 200, { ok: true, text: extracted.text, file: publicFile(extracted.file) }); return;
  }
  if (request.url === "/v1/deliveries/register") { sendJson(response, 200, { ok: true, ...(await registerDelivery(body)) }); return; }
  if (request.url === "/v1/deliveries/active") { sendJson(response, 200, { ok: true, ...activeDelivery(body) }); return; }
  if (request.url === "/v1/deliveries/enqueue") { sendJson(response, 200, { ok: true, ...enqueueDelivery(body) }); return; }
  if (request.url === "/v1/deliveries/status") { sendJson(response, 200, { ok: true, ...deliveryStatus(body) }); return; }
  if (request.url === "/v1/deliveries/complete") { sendJson(response, 200, { ok: true, ...completeDelivery(body) }); return; }
  sendJson(response, 404, { error: { code: "NOT_FOUND", message: "route not found" } });
}

const server = createServer((request, response) => {
  void route(request, response).catch((error) => {
    const code = errorCode(error);
    const status = code === "NOT_FOUND" ? 404 : code === "INTERNAL_ERROR" ? 500 : 400;
    audit("media.request_failed", { route: request.url, errorCode: code });
    if (!response.headersSent) sendJson(response, status, { error: { code, message: error instanceof WorkFileError ? error.message : "media bridge request failed" } });
    else response.destroy();
  });
});

server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660);
  audit("media.bridge_ready", { maxFileBytes: MAX_WORK_FILE_BYTES });
  wakeNativeWorker();
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (nativeWorkerTimer) clearTimeout(nativeWorkerTimer);
    nativeWorkerChild?.kill("SIGTERM");
    server.close(() => { db.close(); process.exit(0); });
  });
}
