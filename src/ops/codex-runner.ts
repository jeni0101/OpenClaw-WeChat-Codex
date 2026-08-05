import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { redactDiagnosticText } from "./security.js";

type JsonObject = Record<string, unknown>;

interface AppServerClient {
  request(method: string, params: JsonObject, options?: { timeoutMs?: number }): Promise<unknown>;
  addNotificationHandler(handler: (notification: JsonObject) => void): () => void;
  addRequestHandler(handler: (request: JsonObject) => unknown): () => void;
  close(): void;
}

type AppServerClientFactory = (options: {
  startOptions: {
    transport: "stdio";
    homeScope: "agent";
    command: string;
    commandSource: "config";
    args: string[];
    headers: Record<string, string>;
    env: Record<string, string>;
    clearEnv: string[];
  };
  timeoutMs: number;
  agentDir: string;
  config?: unknown;
}) => Promise<AppServerClient>;

export interface CodexRunnerOptions {
  codexExecutable: string;
  codexHome: string;
  agentDir: string;
  cwd?: string;
  request?: string;
  authProbe?: boolean;
  timeoutMs?: number;
  clientFactory?: AppServerClientFactory;
}

export interface CodexRunnerResult {
  authenticated: boolean;
  models: number;
  summary?: string;
}

class CodexRunnerFailure extends Error {
  constructor(readonly stage: "authentication" | "task-execution", cause: unknown) {
    super(cause instanceof Error ? cause.message : "managed Codex runner failed");
    this.name = "CodexRunnerFailure";
  }
}

function looksLikeAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:401|403|auth(?:entication|orization)?|bearer|credential|login|unauthorized)\b/i.test(message);
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const record = asObject(value);
  return typeof record?.[key] === "string" ? record[key] : undefined;
}

async function resolveManagedClientFactory(): Promise<AppServerClientFactory> {
  const openClawEntry = fileURLToPath(import.meta.resolve("openclaw"));
  const distDir = path.dirname(openClawEntry);
  const candidates: string[] = [];
  for (const name of await readdir(distDir)) {
    if (!/^shared-client-[A-Za-z0-9_-]+\.js$/.test(name)) continue;
    const filePath = path.join(distDir, name);
    const source = await readFile(filePath, "utf8");
    if (
      source.includes("createIsolatedCodexAppServerClient") &&
      source.includes("export {") &&
      !source.includes("function createIsolatedCodexAppServerClient")
    ) {
      candidates.push(filePath);
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`managed Codex auth bridge resolution returned ${candidates.length} candidates`);
  }
  const loaded = await import(pathToFileURL(candidates[0]!).href) as Record<string, unknown>;
  const factory = loaded.createIsolatedCodexAppServerClient;
  if (typeof factory !== "function") throw new Error("managed Codex auth bridge factory is unavailable");
  return factory as AppServerClientFactory;
}

function startOptions(
  options: CodexRunnerOptions,
  runtimeHome: string,
  tempRoot: string,
): Parameters<AppServerClientFactory>[0]["startOptions"] {
  return {
    transport: "stdio",
    homeScope: "agent",
    command: options.codexExecutable,
    commandSource: "config",
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/sbin:/usr/bin:/sbin:/bin`,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      HOME: runtimeHome,
      CODEX_HOME: runtimeHome,
      TMPDIR: tempRoot,
    },
    clearEnv: [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_BASE_URL",
      "OPENCLAW_CODEX_APP_SERVER_ARGS",
    ],
  };
}

function approvalResponse(request: JsonObject): unknown {
  const method = readString(request, "method") ?? "";
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (method === "mcpServer/elicitation/request") return { action: "decline" };
  if (method.includes("requestApproval")) {
    return { decision: "decline", reason: "isolated project task does not grant native approvals" };
  }
  return undefined;
}

async function modelCount(client: AppServerClient, timeoutMs: number): Promise<number> {
  const response = asObject(await client.request("model/list", {
    limit: null,
    cursor: null,
    includeHidden: false,
  }, { timeoutMs }));
  return Array.isArray(response?.data) ? response.data.length : 0;
}

async function runTurn(
  client: AppServerClient,
  cwd: string,
  request: string,
  timeoutMs: number,
  sandbox: "read-only" | "workspace-write",
): Promise<string> {
  const listed = asObject(await client.request("model/list", {
    limit: null,
    cursor: null,
    includeHidden: false,
  }, { timeoutMs }));
  const models = Array.isArray(listed?.data) ? listed.data.map(asObject).filter(Boolean) : [];
  const selected = models.find((model) => model?.isDefault === true) ?? models[0];
  const model = readString(selected, "model") ?? readString(selected, "id");
  if (!model) throw new Error("managed Codex app-server returned no usable model");

  const started = asObject(await client.request("thread/start", {
    cwd,
    model,
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox,
    serviceName: "WeChat ClawBot project-ops",
    developerInstructions: [
      "Operate only inside the supplied isolated staging directory.",
      "Do not access the live repository, credentials, environment variables, or identity data.",
      "Complete the requested repository task and finish with a concise validation summary.",
    ].join(" "),
    config: {
      "features.multi_agent": false,
      "features.apps": false,
      "features.plugins": false,
      "features.image_generation": false,
      "features.standalone_web_search": false,
      "features.hooks": false,
      web_search: "disabled",
      notify: [],
    },
    environments: [],
    dynamicTools: [],
    experimentalRawEvents: true,
    ephemeral: true,
  }, { timeoutMs }));
  const thread = asObject(started?.thread);
  const threadId = readString(thread, "id");
  if (!threadId) throw new Error("managed Codex app-server did not return a thread id");

  let turnId: string | undefined;
  let completedStatus: string | undefined;
  let completedError: string | undefined;
  const assistantText = new Map<string, string>();
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  const removeNotification = client.addNotificationHandler((notification) => {
    const params = asObject(notification.params);
    if (!params || readString(params, "threadId") !== threadId) return;
    const notificationTurn = readString(params, "turnId") ?? readString(asObject(params.turn), "id");
    if (turnId && notificationTurn && notificationTurn !== turnId) return;
    const method = readString(notification, "method");
    if (method === "item/agentMessage/delta") {
      const itemId = readString(params, "itemId") ?? "assistant";
      const delta = readString(params, "delta") ?? "";
      assistantText.set(itemId, `${assistantText.get(itemId) ?? ""}${delta}`);
    } else if (method === "item/completed") {
      const item = asObject(params.item);
      if (readString(item, "type") === "agentMessage") {
        assistantText.set(readString(item, "id") ?? "assistant", readString(item, "text") ?? "");
      }
    } else if (method === "turn/completed") {
      const turn = asObject(params.turn);
      completedStatus = readString(turn, "status");
      completedError = readString(asObject(turn?.error), "message");
      resolveCompletion?.();
    } else if (method === "error") {
      completedStatus = "failed";
      completedError = readString(asObject(params.error), "message") ?? "managed Codex turn failed";
      resolveCompletion?.();
    }
  });
  const removeRequests = client.addRequestHandler(approvalResponse);
  try {
    const turnStarted = asObject(await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: request, text_elements: [] }],
      cwd,
      approvalPolicy: "never",
      model,
      effort: "medium",
    }, { timeoutMs }));
    turnId = readString(asObject(turnStarted?.turn), "id");
    if (!turnId) throw new Error("managed Codex app-server did not return a turn id");
    await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("managed Codex turn timed out")), timeoutMs);
        timer.unref();
      }),
    ]);
    if (completedStatus === "failed") throw new Error(completedError ?? "managed Codex turn failed");
    const summary = [...assistantText.values()].map((value) => value.trim()).filter(Boolean).join("\n\n");
    if (!summary) throw new Error("managed Codex turn returned no final summary");
    return summary;
  } finally {
    removeRequests();
    removeNotification();
  }
}

export async function runCodexRunner(options: CodexRunnerOptions): Promise<CodexRunnerResult> {
  const timeoutMs = options.timeoutMs ?? 45 * 60_000;
  const factory = options.clientFactory ?? await resolveManagedClientFactory();
  const tempRoot = process.env.TMPDIR?.trim()
    || path.join(path.dirname(path.dirname(options.codexHome)), "tmp");
  await mkdir(tempRoot, { recursive: true, mode: 0o750 });
  const runtimeHome = await mkdtemp(path.join(tempRoot, "project-ops-codex-"));
  let client: AppServerClient | undefined;
  try {
    try {
      client = await factory({
        startOptions: startOptions(options, runtimeHome, tempRoot),
        timeoutMs,
        agentDir: options.agentDir,
        config: loadConfig(),
      });
      const models = await modelCount(client, timeoutMs);
      if (models === 0) throw new Error("managed Codex app-server returned no models");
      if (options.authProbe) {
        await runTurn(
          client,
          tempRoot,
          "Reply with exactly AUTH_OK. Do not use tools and do not read or write files.",
          timeoutMs,
          "read-only",
        );
        return { authenticated: true, models };
      }
      if (!options.cwd || options.request === undefined) throw new Error("cwd and request are required");
      try {
        return {
          authenticated: true,
          models,
          summary: await runTurn(client, options.cwd, options.request, timeoutMs, "workspace-write"),
        };
      } catch (error) {
        throw new CodexRunnerFailure(
          looksLikeAuthenticationFailure(error) ? "authentication" : "task-execution",
          error,
        );
      }
    } catch (error) {
      if (error instanceof CodexRunnerFailure) throw error;
      throw new CodexRunnerFailure("authentication", error);
    }
  } finally {
    client?.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const authProbe = process.argv.includes("--auth-probe");
  const common = {
    codexExecutable: argument("--codex") ?? "",
    codexHome: argument("--codex-home") ?? "",
    agentDir: argument("--agent-dir") ?? "",
  };
  const result = await runCodexRunner(authProbe
    ? { ...common, authProbe: true }
    : {
      ...common,
      cwd: argument("--cwd") ?? "",
      request: await readStdin(),
    });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    const stage = error instanceof CodexRunnerFailure ? error.stage : "authentication";
    const safe = redactDiagnosticText(
      error instanceof Error ? error.message : "managed Codex runner failed",
      "",
    );
    process.stderr.write(`${JSON.stringify({ code: "CODEX_RUNNER_FAILED", stage, message: safe })}\n`);
    process.exitCode = stage === "authentication" ? 78 : 70;
  });
}
