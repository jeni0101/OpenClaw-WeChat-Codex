import { chmod, lchown, readdir, readFile, rename, rm, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readBudget } from "../src/ops/budget.js";
import { resolveServiceIdentity } from "../src/ops/identity.js";
import { runCommand } from "../src/ops/process.js";
import { loadRegistry } from "../src/ops/registry.js";
import type { BrokerOptions } from "../src/ops/types.js";

const DAY = 24 * 60 * 60 * 1000;
const LOG_BUDGET = 512 * 1024 * 1024;
const MEDIA_BUDGET = 768 * 1024 * 1024;

interface MaintenanceEvent { action: string; path?: string; detail?: unknown }

async function setSessionOwnership(root: string, uid: number, gid: number): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await setSessionOwnership(target, uid, gid);
    await lchown(target, uid, gid);
    await chmod(target, entry.isDirectory() ? 0o700 : 0o600);
  }
  await lchown(root, uid, gid);
  await chmod(root, 0o700);
}

async function pruneChildren(root: string, olderThanMs: number, events: MaintenanceEvent[]): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - olderThanMs;
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    const info = await stat(target, { bigint: false }).catch(() => null);
    if (!info || info.mtimeMs >= cutoff) continue;
    await rm(target, { recursive: entry.isDirectory(), force: true });
    events.push({ action: "pruned", path: target });
  }
}

async function pruneStages(options: BrokerOptions, events: MaintenanceEvent[]): Promise<void> {
  const root = path.join(options.dataDir, "staging");
  const manifests = (await readdir(root).catch(() => [])).filter((name) => name.endsWith(".json"));
  const registry = await loadRegistry(options.registryPath);
  const cutoff = Date.now() - 7 * DAY;
  for (const name of manifests) {
    const manifestFile = path.join(root, name);
    const info = await stat(manifestFile).catch(() => null);
    if (!info || info.mtimeMs >= cutoff) continue;
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { path?: string; mode?: string; projectId?: string };
    const stagePath = manifest.path ? path.resolve(manifest.path) : "";
    if (stagePath !== path.join(root, path.basename(name, ".json"))) continue;
    const project = manifest.projectId ? registry.projects.get(manifest.projectId) : undefined;
    if (manifest.mode === "git-worktree" && project) {
      await runCommand([
        "/usr/bin/git", "-c", `safe.directory=${project.realPath}`, "-C", project.realPath,
        "worktree", "remove", "--force", stagePath,
      ], {
        timeoutMs: 120_000,
        maxOutputBytes: 64 * 1024,
      }).catch(() => undefined);
    }
    await rm(stagePath, { recursive: true, force: true });
    await rm(manifestFile, { force: true });
    events.push({ action: "stage_pruned", path: stagePath });
  }
}

async function checkpointSqlite(root: string, events: MaintenanceEvent[]): Promise<void> {
  const queue = [root];
  while (queue.length) {
    const current = queue.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile() && target.endsWith(".sqlite")) {
        const result = await runCommand(["/usr/bin/sqlite3", target, "PRAGMA wal_checkpoint(TRUNCATE);"], {
          timeoutMs: 60_000,
          maxOutputBytes: 16 * 1024,
        }).catch(() => null);
        events.push({ action: "sqlite_checkpoint", path: target, detail: result ? { code: result.code } : { unavailable: true } });
      }
    }
  }
}

async function pruneRollback(root: string, events: MaintenanceEvent[]): Promise<void> {
  for (const project of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!project.isDirectory()) continue;
    const directory = path.join(root, project.name);
    const manifests = [];
    for (const name of (await readdir(directory)).filter((value) => value.endsWith(".json"))) {
      const info = await stat(path.join(directory, name));
      manifests.push({ name, mtimeMs: info.mtimeMs });
    }
    manifests.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of manifests.slice(2)) {
      const id = path.basename(stale.name, ".json");
      await rm(path.join(directory, `${id}.json`), { force: true });
      await rm(path.join(directory, `${id}.patch`), { force: true });
      events.push({ action: "rollback_pruned", path: `${project.name}/${id}` });
    }
  }
}

async function enforceLogBudget(logDir: string, events: MaintenanceEvent[]): Promise<void> {
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of await readdir(logDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const target = path.join(logDir, entry.name);
    const info = await stat(target);
    const retention = entry.name.startsWith("gateway") ? 7 * DAY : 30 * DAY;
    if (info.mtimeMs < Date.now() - retention) {
      await rm(target, { force: true });
      events.push({ action: "log_pruned", path: target });
    } else {
      files.push({ path: target, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    if (total <= LOG_BUDGET) break;
    await rm(file.path, { force: true });
    total -= file.size;
    events.push({ action: "log_budget_pruned", path: file.path });
  }
}

async function protectedMediaPaths(dataDir: string): Promise<Set<string>> {
  const databasePath = path.join(dataDir, "state", "media-bridge.sqlite");
  const available = await stat(databasePath).catch(() => null);
  if (!available) return new Set();
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT source_path FROM deliveries WHERE state IN ('pending','failed','object_ready')").all() as unknown as Array<{ source_path: string }>;
    return new Set(rows.map((row) => path.resolve(row.source_path)));
  } catch {
    return new Set();
  } finally {
    db.close();
  }
}

async function collectMediaFiles(root: string, retentionMs: number, files: Array<{ path: string; size: number; mtimeMs: number; retentionMs: number }>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await collectMediaFiles(target, retentionMs, files);
    else if (entry.isFile()) {
      const info = await stat(target);
      files.push({ path: target, size: info.size, mtimeMs: info.mtimeMs, retentionMs });
    }
  }
}

async function enforceMediaBudget(dataDir: string, events: MaintenanceEvent[]): Promise<void> {
  const files: Array<{ path: string; size: number; mtimeMs: number; retentionMs: number }> = [];
  for (const [relative, retentionMs] of [
    ["cache/media", 7 * DAY],
    ["state/media/inbound", 7 * DAY],
    ["workspace/media/inbound", 7 * DAY],
    ["state/agents/main/agent/codex-home/generated_images", 7 * DAY],
    ["quarantine", 3 * DAY],
  ] as const) await collectMediaFiles(path.join(dataDir, relative), retentionMs, files);
  const protectedPaths = await protectedMediaPaths(dataDir);
  const now = Date.now();
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (protectedPaths.has(path.resolve(file.path)) || file.mtimeMs >= now - file.retentionMs) continue;
    await rm(file.path, { force: true });
    total -= file.size;
    events.push({ action: "media_retention_pruned", path: file.path });
  }
  if (total > MEDIA_BUDGET * 0.8) {
    const eligible = files
      .filter((file) => !protectedPaths.has(path.resolve(file.path)))
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of eligible) {
      if (total <= MEDIA_BUDGET * 0.7) break;
      const exists = await stat(file.path).catch(() => null);
      if (!exists) continue;
      await rm(file.path, { force: true });
      total -= exists.size;
      events.push({ action: "media_budget_pruned", path: file.path });
    }
  }
  events.push({
    action: "media_budget",
    detail: { bytes: total, budgetBytes: MEDIA_BUDGET, usagePercent: Math.round(total / MEDIA_BUDGET * 10_000) / 100 },
  });
}

export async function runMaintenance(projectRoot = "/opt/WeChat-Open in"): Promise<Record<string, unknown>> {
  const dataDir = process.env.WECHAT_CLAWBOT_DATA ?? path.join(projectRoot, "data");
  const options: BrokerOptions = {
    socketPath: path.join(dataDir, "run", "project-ops.sock"),
    dataDir,
    registryPath: path.join(projectRoot, "config", "projects.yaml"),
    token: "maintenance-not-used",
    ownerId: "maintenance-not-used",
    maxOutputBytes: 64 * 1024,
    approvalTtlMs: 10 * 60_000,
  };
  const serviceIdentity = await resolveServiceIdentity();
  const events: MaintenanceEvent[] = [];
  await pruneChildren(path.join(dataDir, "tmp"), DAY, events);
  await pruneChildren(path.join(dataDir, "cache", "media"), 7 * DAY, events);
  await pruneChildren(path.join(dataDir, "tasks"), DAY, events);
  await pruneStages(options, events);
  await pruneRollback(path.join(dataDir, "rollback"), events);
  await enforceLogBudget(path.join(dataDir, "logs"), events);
  await enforceMediaBudget(dataDir, events);
  await checkpointSqlite(path.join(dataDir, "state"), events);

  const gatewayToken = process.env.CREDENTIALS_DIRECTORY
    ? (await readFile(path.join(process.env.CREDENTIALS_DIRECTORY, "gateway-token"), "utf8").catch(() => "")).trim()
    : "";
  const cleanup = await runCommand([
    process.execPath,
    path.join(projectRoot, "node_modules", "openclaw", "openclaw.mjs"),
    "sessions", "cleanup", "--enforce", "--all-agents",
  ], {
    timeoutMs: 10 * 60_000,
    maxOutputBytes: 128 * 1024,
    env: {
      PATH: `${path.join(dataDir, "node", "bin")}:/usr/sbin:/usr/bin:/sbin:/bin`,
      LANG: "C.UTF-8",
      HOME: path.join(dataDir, "home"),
      OPENCLAW_STATE_DIR: path.join(dataDir, "state"),
      OPENCLAW_CONFIG_PATH: path.join(projectRoot, "config", "openclaw.json"),
      ...(gatewayToken ? { OPENCLAW_GATEWAY_TOKEN: gatewayToken } : {}),
    },
  });
  events.push({
    action: "session_cleanup",
    detail: {
      code: cleanup.code,
      stdout: cleanup.stdout.slice(0, 1000),
      stderr: cleanup.stderr.replace(/(token|secret|password)\s*[=:]\s*\S+/gi, "$1=[REDACTED]").slice(0, 1000),
    },
  });
  await setSessionOwnership(
    path.join(dataDir, "state", "agents", "main", "sessions"),
    serviceIdentity.uid,
    serviceIdentity.gid,
  );
  for (const entry of await readdir(path.join(dataDir, "logs"), { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile()) {
      const mode = entry.name.startsWith("gateway") ? 0o600 : 0o640;
      await chmod(path.join(dataDir, "logs", entry.name), mode).catch(() => undefined);
    }
  }

  const trim = await runCommand(["/usr/sbin/fstrim", dataDir], {
    timeoutMs: 5 * 60_000,
    maxOutputBytes: 16 * 1024,
  }).catch(() => null);
  events.push({ action: "data_volume_trim", detail: trim ? { code: trim.code, output: trim.stdout.trim() } : { unavailable: true } });

  const budget = await readBudget(options);
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), budget, events };
  const reportsDir = path.join(dataDir, "reports");
  await mkdir(reportsDir, { recursive: true, mode: 0o750 });
  const current = path.join(reportsDir, "disk-budget.json");
  const temporary = `${current}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o640 });
  await rename(temporary, current);
  return report;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runMaintenance(process.env.WECHAT_CLAWBOT_ROOT).then((report) => {
    process.stdout.write(`${JSON.stringify({ ok: true, budget: report.budget })}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
    process.exitCode = 1;
  });
}
