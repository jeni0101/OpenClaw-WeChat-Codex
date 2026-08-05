import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalService } from "./approvals.js";
import { readBudget } from "./budget.js";
import { asBrokerError, BrokerError } from "./errors.js";
import { fingerprintProject } from "./fingerprint.js";
import { resolveServiceIdentity } from "./identity.js";
import { runCommand } from "./process.js";
import { getProject, loadRegistry } from "./registry.js";
import { assertOwner, redactObject, secretEquals, sha256 } from "./security.js";
import type { Actor, BrokerOptions, ChangeKind, PrepareRequest } from "./types.js";

const MAX_BODY_BYTES = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BrokerError("BODY_TOO_LARGE", "request body exceeds 64 KiB", 413);
    chunks.push(chunk);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BrokerError("INVALID_BODY", "JSON object required");
  return parsed as Record<string, unknown>;
}

function actorFrom(body: Record<string, unknown>): Actor {
  const actor = body.actor;
  if (!actor || typeof actor !== "object") throw new BrokerError("ACTOR_REQUIRED", "actor is required", 403);
  const value = actor as Record<string, unknown>;
  if (typeof value.senderId !== "string" || typeof value.channel !== "string" || typeof value.senderIsOwner !== "boolean") {
    throw new BrokerError("ACTOR_REQUIRED", "actor fields are invalid", 403);
  }
  return { senderId: value.senderId, channel: value.channel, senderIsOwner: value.senderIsOwner };
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(redactObject(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

export function createBroker(options: BrokerOptions) {
  const approvals = new ApprovalService(options);
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST") throw new BrokerError("METHOD_NOT_ALLOWED", "POST required", 405);
      const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
      if (!secretEquals(supplied, options.token)) throw new BrokerError("UNAUTHORIZED", "invalid broker credential", 401);
      const body = await readBody(req);
      const actor = actorFrom(body);
      assertOwner(actor, options.ownerId);
      if (req.url === "/v1/projects/list") {
        const registry = await loadRegistry(options.registryPath);
        send(res, 200, {
          projects: [...registry.projects.values()].map(({ id, description, capabilities, sourceMode }) => ({
            id, description, capabilities, sourceMode,
          })),
          unavailableProjects: [...registry.unavailableProjects.values()],
        });
        return;
      }
      if (req.url === "/v1/projects/status") {
        const projectId = String(body.projectId ?? "");
        const project = getProject(await loadRegistry(options.registryPath), projectId);
        const checks = [];
        for (const check of project.status) {
          const result = await runCommand(check.argv, {
            cwd: project.realPath,
            timeoutMs: check.timeoutMs ?? 15_000,
            maxOutputBytes: options.maxOutputBytes,
          });
          checks.push({ name: check.name, ok: result.code === 0, result });
        }
        const git = await runCommand([
          "/usr/bin/git", "-c", `safe.directory=${project.realPath}`, "-C", project.realPath,
          "status", "--short", "--branch",
        ], {
          maxOutputBytes: options.maxOutputBytes,
        }).catch(() => null);
        send(res, 200, {
          projectId,
          sourceHash: await fingerprintProject(project),
          budget: await readBudget(options),
          checks,
          git: git && git.code === 0 ? { ok: true, output: git.stdout } : { ok: false },
        });
        return;
      }
      if (req.url === "/v1/approvals/prepare") {
        const prepare: PrepareRequest = {
          projectId: String(body.projectId ?? ""),
          kind: String(body.kind ?? "") as ChangeKind,
          request: String(body.request ?? ""),
          ...(body.stageId === undefined ? {} : { stageId: String(body.stageId) }),
          ...(body.snapshotId === undefined ? {} : { snapshotId: String(body.snapshotId) }),
          actor,
        };
        send(res, 201, await approvals.prepare(prepare));
        return;
      }
      if (req.url === "/v1/approvals/decide") {
        const decision = body.decision === "allow" ? "allow" : body.decision === "deny" ? "deny" : null;
        if (!decision) throw new BrokerError("INVALID_DECISION", "decision must be allow or deny");
        send(res, 200, await approvals.decide(String(body.approvalId ?? ""), decision, actor));
        return;
      }
      if (req.url === "/v1/approvals/execute") {
        send(res, 202, await approvals.execute(String(body.approvalId ?? ""), actor));
        return;
      }
      if (req.url === "/v1/approvals/status") {
        send(res, 200, await approvals.status(String(body.approvalId ?? ""), actor));
        return;
      }
      if (req.url === "/v1/approvals/result") {
        send(res, 200, await approvals.failureResult(String(body.approvalId ?? ""), actor));
        return;
      }
      throw new BrokerError("NOT_FOUND", "route not found", 404);
    } catch (error) {
      const normalized = asBrokerError(error);
      await approvals.audit.append({
        event: "broker.request_failed",
        path: req.url,
        code: normalized.code,
        message: normalized.message,
      }).catch(() => undefined);
      send(res, normalized.statusCode, { error: { code: normalized.code, message: normalized.message } });
    }
  });
  server.once("close", () => approvals.stop());
  return Object.assign(server, { approvalService: approvals });
}

async function credential(name: string, envName: string): Promise<string> {
  const direct = process.env[envName];
  if (direct) return direct.trim();
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory) throw new Error(`${envName} or CREDENTIALS_DIRECTORY is required`);
  return (await readFile(path.join(directory, name), "utf8")).trim();
}

export async function startBroker(overrides: Partial<BrokerOptions> = {}): Promise<ReturnType<typeof createBroker>> {
  const dataDir = overrides.dataDir ?? process.env.WECHAT_CLAWBOT_DATA ?? "/opt/WeChat-Open in/data";
  const socketPath = overrides.socketPath ?? process.env.WECHAT_CLAWBOT_SOCKET ?? path.join(dataDir, "run", "project-ops.sock");
  const token = overrides.token ?? await credential("broker-token", "WECHAT_CLAWBOT_BROKER_TOKEN");
  const ownerId = overrides.ownerId ?? await credential("owner-wechat-id", "WECHAT_CLAWBOT_OWNER_ID");
  const codexEnabled = process.env.WECHAT_CLAWBOT_CODEX_ENABLED === "1";
  const serviceIdentity = codexEnabled ? await resolveServiceIdentity() : undefined;
  const options: BrokerOptions = {
    socketPath,
    dataDir,
    registryPath: overrides.registryPath ?? process.env.WECHAT_CLAWBOT_REGISTRY ?? "/opt/WeChat-Open in/config/projects.yaml",
    token,
    ownerId,
    maxOutputBytes: overrides.maxOutputBytes ?? 64 * 1024,
    approvalTtlMs: overrides.approvalTtlMs ?? 10 * 60_000,
    executionTimeoutMs: overrides.executionTimeoutMs ?? 45 * 60_000,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 10_000,
    leaseDurationMs: overrides.leaseDurationMs ?? 45_000,
    orphanSweepIntervalMs: overrides.orphanSweepIntervalMs ?? 10_000,
    ...(codexEnabled && serviceIdentity ? {
      codexExecutable: process.env.WECHAT_CLAWBOT_CODEX_EXECUTABLE ?? "/usr/bin/codex",
      codexRunner: process.env.WECHAT_CLAWBOT_CODEX_RUNNER ?? "/opt/WeChat-Open in/dist/src/ops/codex-runner.js",
      codexHome: process.env.WECHAT_CLAWBOT_CODEX_HOME ?? path.join(dataDir, "state", "codex"),
      codexAgentDir: process.env.WECHAT_CLAWBOT_CODEX_AGENT_DIR ?? path.join(dataDir, "state", "agents", "main", "agent"),
      codexConfigPath: process.env.OPENCLAW_CONFIG_PATH ?? "/opt/WeChat-Open in/config/openclaw.json",
      serviceUid: serviceIdentity.uid,
      serviceGid: serviceIdentity.gid,
    } : {}),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  };
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
  await rm(socketPath, { force: true });
  const server = createBroker(options);
  await server.approvalService.start();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, 0o660);
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  startBroker().catch((error) => {
    process.stderr.write(`${JSON.stringify({ level: "error", event: "broker.start_failed", error: String(error) })}\n`);
    process.exitCode = 1;
  });
}
