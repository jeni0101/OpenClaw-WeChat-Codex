import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService } from "../src/ops/approvals.js";
import { SIMPLE_UPLOAD_LIMIT_BYTES, uploadStrategy } from "../src/cos/client.js";
import { BrokerError } from "../src/ops/errors.js";
import { runCommand } from "../src/ops/process.js";
import { parseServiceId } from "../src/ops/identity.js";
import { isMigrationSourcePath, shouldTraverseMigrationDirectory } from "../scripts/migration-bundle.js";
import { getProject, loadRegistry } from "../src/ops/registry.js";
import { assertOwner, isExcludedRelativePath, redactDiagnosticText, redactObject, requestSummary, sha256 } from "../src/ops/security.js";
import { inspectApplyRetryEligibility, loadStage, stagePreview } from "../src/ops/staging.js";
import { runCodexRunner } from "../src/ops/codex-runner.js";
import type { Actor, BrokerOptions } from "../src/ops/types.js";

const roots: string[] = [];
const owner: Actor = { senderId: "wx-owner-123", channel: "openclaw-weixin", senderIsOwner: true };

async function fixture(now?: () => Date): Promise<{ root: string; project: string; options: BrokerOptions; service: ApprovalService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wechat-clawbot-test-"));
  roots.push(root);
  await chmod(root, 0o755);
  const project = path.join(root, "project");
  const data = path.join(root, "data");
  await mkdir(project);
  await mkdir(data);
  await mkdir(path.join(data, "tmp"));
  const codexHome = path.join(root, "codex-home");
  await mkdir(codexHome);
  const runner = path.join(root, "successful-runner.js");
  await writeFile(runner, 'process.stdout.write(JSON.stringify({ authenticated: true, models: 1, summary: "validated" }));\n');
  await writeFile(path.join(project, "app.txt"), "initial\n");
  const configDir = path.join(root, "config");
  await mkdir(configDir);
  const registryPath = path.join(configDir, "projects.yaml");
  await writeFile(registryPath, [
    "version: 1",
    "projects:",
    "  demo:",
    `    path: ${JSON.stringify(project)}`,
    "    sourceMode: snapshot",
    "    description: test fixture",
    "    capabilities: [status, develop]",
    "    status: []",
    "    actions: {}",
    "",
  ].join("\n"));
  const options: BrokerOptions = {
    socketPath: path.join(data, "broker.sock"),
    dataDir: data,
    registryPath,
    token: "broker-test-token-with-length",
    ownerId: owner.senderId,
    maxOutputBytes: 1024,
    approvalTtlMs: 10 * 60_000,
    codexExecutable: "/usr/bin/false",
    codexRunner: runner,
    codexHome,
    codexAgentDir: root,
    codexConfigPath: path.join(root, "openclaw.json"),
    serviceUid: process.getuid(),
    serviceGid: process.getgid(),
    ...(now ? { now } : {}),
  };
  return { root, project, options, service: new ApprovalService(options) };
}

async function cleanGitFixture(testCommand: string[] | string[][]): Promise<{
  root: string; project: string; options: BrokerOptions; service: ApprovalService;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wechat-clawbot-test-"));
  roots.push(root);
  await chmod(root, 0o755);
  const project = path.join(root, "project");
  const data = path.join(root, "data");
  const configDir = path.join(root, "config");
  await mkdir(project);
  await mkdir(data);
  await mkdir(path.join(data, "tmp"));
  await mkdir(configDir);
  await writeFile(path.join(project, "app.txt"), "initial\n");
  for (const argv of [
    ["/usr/bin/git", "init", "-q", project],
    ["/usr/bin/git", "-C", project, "config", "user.name", "ClawBot Test"],
    ["/usr/bin/git", "-C", project, "config", "user.email", "clawbot-test@localhost"],
    ["/usr/bin/git", "-C", project, "add", "app.txt"],
    ["/usr/bin/git", "-C", project, "commit", "-q", "-m", "fixture"],
  ]) {
    const result = await runCommand(argv);
    if (result.code !== 0) throw new Error(result.stderr);
  }
  const applyUid = process.getuid() === 0 ? 65_534 : process.getuid();
  const applyGid = process.getgid() === 0 ? 65_534 : process.getgid();
  if (process.getuid() === 0) {
    const ownership = await runCommand(["/usr/bin/chown", "-R", `${applyUid}:${applyGid}`, project]);
    if (ownership.code !== 0) throw new Error(ownership.stderr);
  }
  const registryPath = path.join(configDir, "projects.yaml");
  const codexHome = path.join(root, "codex-home");
  await mkdir(codexHome);
  const runner = path.join(root, "successful-runner.js");
  await writeFile(runner, 'process.stdout.write(JSON.stringify({ authenticated: true, models: 1, summary: "validated" }));\n');
  const verifyCommands = Array.isArray(testCommand[0]) ? testCommand as string[][] : [testCommand as string[]];
  await writeFile(registryPath, [
    "version: 1", "projects:", "  demo:", `    path: ${JSON.stringify(project)}`,
    "    sourceMode: clean-git", "    description: integration fixture",
    "    capabilities: [status, develop, apply, rollback]", "    status: []", "    actions: {}",
    "    apply:",
    "      allowedPaths: [app.txt]",
    `      verify: ${JSON.stringify(verifyCommands)}`,
    `      uid: ${applyUid}`,
    `      gid: ${applyGid}`,
    "",
  ].join("\n"));
  const options: BrokerOptions = {
    socketPath: path.join(data, "broker.sock"), dataDir: data, registryPath,
    token: "broker-test-token-with-length", ownerId: owner.senderId,
    maxOutputBytes: 1024 * 1024, approvalTtlMs: 10 * 60_000,
    codexExecutable: "/usr/bin/false", codexRunner: runner, codexHome,
    codexAgentDir: root, codexConfigPath: path.join(root, "openclaw.json"),
    serviceUid: process.getuid(), serviceGid: process.getgid(),
  };
  return { root, project, options, service: new ApprovalService(options) };
}

async function executeToTerminal(service: ApprovalService, approvalId: string): Promise<Awaited<ReturnType<ApprovalService["load"]>>> {
  const accepted = await service.execute(approvalId, owner);
  expect(accepted.state).toBe("running");
  const terminal = await service.waitForTerminal(approvalId);
  await new Promise((resolve) => setImmediate(resolve));
  return terminal;
}

async function persistFailureFixture(
  service: ApprovalService,
  approvalId: string,
  stageId: string,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const record = await service.load(approvalId);
  record.state = "failed";
  record.stageId = stageId;
  await writeFile(
    path.join(service.options.dataDir, "approvals", `${approvalId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    approvalId,
    stageId,
    createdAt: "2026-07-26T08:00:00.000Z",
    sandboxStage: "task-execution",
    exitCode: 7,
    signal: null,
    stdout: "bounded stdout",
    stderr: "bounded stderr",
    outputTruncated: false,
    stageExistedAtCapture: true,
    ...overrides,
  };
  const diagnostic = { ...payload, resultHash: sha256(JSON.stringify(payload)) };
  const tasksDir = path.join(service.options.dataDir, "tasks");
  await mkdir(tasksDir, { recursive: true });
  await writeFile(path.join(tasksDir, `${stageId}.failure.json`), `${JSON.stringify(diagnostic, null, 2)}\n`);
  return diagnostic;
}

async function failedApplyFixture(
  verifyCommands: string[][],
  configure?: (options: BrokerOptions) => void,
): Promise<{
  root: string;
  project: string;
  options: BrokerOptions;
  service: ApprovalService;
  develop: Awaited<ReturnType<ApprovalService["prepare"]>>;
  stage: { id: string; path: string };
  apply: Awaited<ReturnType<ApprovalService["prepare"]>>;
  failed: Awaited<ReturnType<ApprovalService["load"]>>;
}> {
  const fixture = await cleanGitFixture(verifyCommands);
  configure?.(fixture.options);
  const develop = await fixture.service.prepare({
    projectId: "demo", kind: "develop", request: "prepare failed apply fixture", actor: owner,
  });
  await fixture.service.decide(develop.id, "allow", owner);
  const developed = await executeToTerminal(fixture.service, develop.id);
  const stage = developed.result as { id: string; path: string };
  await writeFile(path.join(stage.path, "app.txt"), "staged\n");
  const apply = await fixture.service.prepare({
    projectId: "demo", kind: "apply", request: "exercise failed fixed validation", stageId: stage.id, actor: owner,
  });
  await fixture.service.decide(apply.id, "allow", owner);
  const failed = await executeToTerminal(fixture.service, apply.id);
  expect(failed.state).toBe("failed");
  return { ...fixture, develop, stage, apply, failed };
}

async function readApplyBinding(options: BrokerOptions, stageId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(options.dataDir, "staging", `${stageId}.apply.json`), "utf8"),
  ) as Record<string, unknown>;
}

async function writeApplyBinding(
  options: BrokerOptions,
  stageId: string,
  binding: Record<string, unknown>,
): Promise<void> {
  const normalized = { ...binding };
  delete normalized.bindingHash;
  normalized.bindingHash = sha256(JSON.stringify(normalized));
  await writeFile(
    path.join(options.dataDir, "staging", `${stageId}.apply.json`),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
}

afterEach(async () => {
  for (const root of roots) {
    if (root.startsWith(`${os.tmpdir()}${path.sep}wechat-clawbot-test-`)) {
      await rm(root, { recursive: true, force: true });
    }
  }
  roots.length = 0;
});

describe("security boundaries", () => {
  it("uses bounded streaming uploads before multipart COS uploads", () => {
    expect(uploadStrategy(SIMPLE_UPLOAD_LIMIT_BYTES)).toBe("put-object");
    expect(uploadStrategy(SIMPLE_UPLOAD_LIMIT_BYTES + 1)).toBe("multipart");
  });

  it("accepts portable positive service ids and rejects root or malformed ids", () => {
    expect(parseServiceId("996\n", "uid")).toBe(996);
    expect(() => parseServiceId("0", "uid")).toThrow(/positive/);
    expect(() => parseServiceId("not-a-number", "gid")).toThrow(/positive/);
  });

  it("migration releases include source but exclude state, credentials and backups", () => {
    expect(isMigrationSourcePath("src/ops/broker.ts")).toBe(true);
    expect(isMigrationSourcePath("config/openclaw.json")).toBe(true);
    expect(isMigrationSourcePath("config/openclaw.json.bak")).toBe(false);
    expect(isMigrationSourcePath("data/state/auth.json")).toBe(false);
    expect(isMigrationSourcePath("recovery/wechat-clawbot-recovery.agekey")).toBe(false);
    expect(isMigrationSourcePath("../outside")).toBe(false);
    expect(shouldTraverseMigrationDirectory("", "config")).toBe(true);
    expect(shouldTraverseMigrationDirectory("config", "config/backups")).toBe(false);
    expect(shouldTraverseMigrationDirectory("", "src")).toBe(true);
  });

  it("runs the target-local npm with the target-local Node on PATH", async () => {
    const installer = await readFile(path.join(process.cwd(), "deploy/install-singapore.sh"), "utf8");
    expect(installer).toContain('env PATH="$project_root/data/node/bin:$PATH"');
    expect(installer).toContain("--legacy-peer-deps --no-audit --no-fund");
    expect(installer).toContain('truncate -s 12G "$project_root/.storage/clawbot-data.img"');
    expect(installer).not.toContain('\n  "$project_root/data/node/bin/npm" ci');
    expect(installer).toContain('chown root:root "$project_root/config/openclaw.json"');
    expect(installer).toContain('chmod 0640 "$project_root/config/openclaw.json"');
    expect(installer).toContain("setfacl -m u:wechat-clawbot:rw");
    expect(installer).toContain('"$project_root/config/openclaw.json.last-good"');
    expect(installer).toContain('install -d -o wechat-clawbot -g wechat-clawbot -m 0700 "$project_root/data/state/codex"');
    expect(installer).toContain('run "$project_root/deploy/install-external-plugins.sh"');
  });

  it("keeps restored OpenClaw configuration root-owned and service-readable", async () => {
    const importer = await readFile(path.join(process.cwd(), "deploy/import-restored-state.sh"), "utf8");
    expect(importer).toContain('install -o root -g root -m 0640 "$source" "$destination"');
    expect(importer).toContain("setfacl -m u:wechat-clawbot:rw");
    expect(importer).toContain('copy_config "config/openclaw.json"');
    expect(importer).toContain('install -o wechat-clawbot -g wechat-clawbot -m 0600');
    expect(importer).toContain('"$project_root/config/openclaw.json.last-good"');
    expect(importer.match(/\|\| return 0/g)).toHaveLength(3);
  });

  it("pins and verifies the two required external OpenClaw plugins", async () => {
    const installer = await readFile(path.join(process.cwd(), "deploy/install-external-plugins.sh"), "utf8");
    expect(installer).toContain("@tencent-weixin/openclaw-weixin@2.4.6");
    expect(installer).toContain("@openclaw/codex@2026.7.1-1");
    expect(installer).toContain('plugin.get("status") == "loaded"');
  });

  it("secures the generated owner credential independently of root umask", async () => {
    const configureOwner = await readFile(path.join(process.cwd(), "scripts/configure-owner.ts"), "utf8");
    expect(configureOwner).toContain('wechat-clawbot-owner-wechat-id.cred", 0o600');
  });

  it("reads both encrypted migration release objects back from COS", async () => {
    const bundle = await readFile(path.join(process.cwd(), "scripts/migration-bundle.ts"), "utf8");
    expect(bundle).toContain("downloadObject(cos, settings, archiveKey, readbackArchive)");
    expect(bundle).toContain("downloadObject(cos, settings, key, readbackManifest)");
    expect(bundle).toContain("migration COS readback verification failed");
  });

  it("keeps the pinned runtime Node on the isolated Codex execution PATH", async () => {
    const [staging, runner] = await Promise.all([
      readFile(path.join(process.cwd(), "src/ops/staging.ts"), "utf8"),
      readFile(path.join(process.cwd(), "src/ops/codex-runner.ts"), "utf8"),
    ]);
    for (const source of [staging, runner]) {
      expect(source).toContain("path.dirname(process.execPath)");
    }
  });

  it("rejects non-owner and mismatched owner identities", () => {
    expect(() => assertOwner({ senderId: owner.senderId, senderIsOwner: false }, owner.senderId)).toThrow(/only the bound/);
    expect(() => assertOwner({ senderId: "other", senderIsOwner: true }, owner.senderId)).toThrow(/only the bound/);
  });

  it("rejects control characters and oversized requests", () => {
    expect(() => requestSummary("ok\u0000bad")).toThrow(BrokerError);
    expect(() => requestSummary("x".repeat(4097))).toThrow(/4096/);
  });

  it("redacts secrets and full request bodies", () => {
    expect(redactObject({ token: "abc", requestBody: "private task", nested: { password: "pw" } })).toEqual({
      token: "[REDACTED]",
      requestBody: "[REDACTED]",
      nested: { password: "[REDACTED]" },
    });
  });

  it("redacts and truncates subprocess diagnostics without retaining environment or identity values", () => {
    const request = "private task body";
    const redacted = redactDiagnosticText([
      "TOKEN=not-a-real-token-value",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "owner=wxid_private_owner",
      "contact=user@example.test",
      "path=/home/real-user/project",
      request,
      "x".repeat(100),
    ].join("\n"), request, 180);
    expect(redacted).toContain("[REDACTED_ENV]");
    expect(redacted).toContain("[REDACTED_IDENTITY]");
    expect(redacted).toContain("/[REDACTED_HOME]/project");
    expect(redacted).toContain("[REDACTED_REQUEST]");
    expect(redacted).toContain("[TRUNCATED]");
    expect(redacted).not.toContain("not-a-real-token-value");
    expect(redacted).not.toContain("wxid_private_owner");
    expect(redacted).not.toContain("user@example.test");
    expect(redacted).not.toContain("real-user");
    expect(redacted).not.toContain(request);
  });

  it("excludes credentials, environments, dependencies and path traversal", () => {
    expect(isExcludedRelativePath(".env.production")).toBe(true);
    expect(isExcludedRelativePath("secrets/private-key.pem")).toBe(true);
    expect(isExcludedRelativePath("node_modules/pkg/index.js")).toBe(true);
    expect(isExcludedRelativePath("../outside")).toBe(true);
    expect(isExcludedRelativePath("src/index.ts")).toBe(false);
  });

  it("excludes ephemeral tmp trees from encrypted state backups", async () => {
    const backup = await readFile(path.join(process.cwd(), "scripts/backup.ts"), "utf8");
    expect(backup).toContain('"**/tmp/**"');
  });

  it("does not invoke a shell for metacharacters", async () => {
    const { root } = await fixture();
    const marker = path.join(root, "owned");
    const result = await runCommand(["/usr/bin/printf", "%s", `hello;touch ${marker}`]);
    expect(result.stdout).toContain(";touch");
    await expect(stat(marker)).rejects.toThrow();
  });

  it("caps command output", async () => {
    const result = await runCommand(["/usr/bin/printf", "%010000d", "1"], { maxOutputBytes: 100 });
    expect(Buffer.byteLength(result.stdout)).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it("rejects registry commands outside the executable allowlist", async () => {
    const { root, project } = await fixture();
    const registry = path.join(root, "bad.yaml");
    await writeFile(registry, [
      "version: 1", "projects:", "  bad:", `    path: ${JSON.stringify(project)}`,
      "    sourceMode: snapshot", "    capabilities: [status]",
      "    status:", "      - name: injected", "        argv: [/bin/sh, -c, 'id']", "    actions: {}", "",
    ].join("\n"));
    await expect(loadRegistry(registry)).rejects.toThrow(/not allowed/);
  });

  it("rejects apply path traversal and apply capability without a fixed recipe", async () => {
    const { root, project } = await fixture();
    const traversal = path.join(root, "traversal.yaml");
    await writeFile(traversal, [
      "version: 1", "projects:", "  demo:", `    path: ${JSON.stringify(project)}`,
      "    sourceMode: clean-git", "    capabilities: [status, apply]", "    status: []", "    actions: {}",
      "    apply:", "      allowedPaths: [../outside]", "      stageSetup: []",
      "      verify: [[/usr/bin/python3, -c, pass]]", `      uid: ${process.getuid()}`, `      gid: ${process.getgid()}`,
      "",
    ].join("\n"));
    await expect(loadRegistry(traversal)).rejects.toThrow(/allowedPaths are invalid/);

    const missing = path.join(root, "missing-apply.yaml");
    await writeFile(missing, [
      "version: 1", "projects:", "  demo:", `    path: ${JSON.stringify(project)}`,
      "    sourceMode: clean-git", "    capabilities: [status, apply]", "    status: []", "    actions: {}", "",
    ].join("\n"));
    await expect(loadRegistry(missing)).rejects.toThrow(/requires a clean-git fixed apply recipe/);
  });

  it("rejects npm package scripts that omit the explicit run verb", async () => {
    const { root, project } = await fixture();
    const registry = path.join(root, "invalid-npm-verb.yaml");
    const uid = process.getuid() === 0 ? 65_534 : process.getuid();
    const gid = process.getgid() === 0 ? 65_534 : process.getgid();
    await writeFile(registry, [
      "version: 1", "projects:", "  demo:", `    path: ${JSON.stringify(project)}`,
      "    sourceMode: clean-git", "    capabilities: [status, apply]", "    status: []", "    actions: {}",
      "    apply:", "      allowedPaths: [app.txt]", "      stageSetup: []",
      "      verify: [[/usr/bin/npm, --prefix, frontend, typecheck]]",
      `      uid: ${uid}`, `      gid: ${gid}`, "",
    ].join("\n"));

    await expect(loadRegistry(registry)).rejects.toThrow(/explicit ci, test, or run verb/);
  });

  it("isolates missing project directories without hiding invalid registry commands", async () => {
    const { root, project, options } = await fixture();
    const missing = path.join(root, "removed-project");
    await writeFile(options.registryPath, [
      "version: 1",
      "projects:",
      "  stale:",
      `    path: ${JSON.stringify(missing)}`,
      "    sourceMode: snapshot",
      "    capabilities: [status]",
      "    status: []",
      "    actions: {}",
      "  demo:",
      `    path: ${JSON.stringify(project)}`,
      "    sourceMode: snapshot",
      "    capabilities: [status]",
      "    status: []",
      "    actions: {}",
      "",
    ].join("\n"));
    const registry = await loadRegistry(options.registryPath);
    expect([...registry.projects.keys()]).toEqual(["demo"]);
    expect(registry.unavailableProjects.get("stale")).toEqual({
      id: "stale",
      code: "PROJECT_DIRECTORY_MISSING",
      message: "stale: project directory does not exist",
    });
    expect(getProject(registry, "demo").realPath).toBe(project);
    expect(() => getProject(registry, "stale")).toThrow(/directory does not exist/);

    await writeFile(options.registryPath, [
      "version: 1",
      "projects:",
      "  stale:",
      `    path: ${JSON.stringify(missing)}`,
      "    sourceMode: snapshot",
      "    capabilities: [status]",
      "    status:",
      "      - name: injected",
      "        argv: [/bin/sh, -c, id]",
      "    actions: {}",
      "",
    ].join("\n"));
    await expect(loadRegistry(options.registryPath)).rejects.toThrow(/not allowed/);
  });

  it("rejects stage manifests that escape the staging root", async () => {
    const { options, root } = await fixture();
    const stageId = "11111111-1111-4111-8111-111111111111";
    await mkdir(path.join(options.dataDir, "staging"));
    await writeFile(path.join(options.dataDir, "staging", `${stageId}.json`), JSON.stringify({
      schemaVersion: 1, id: stageId, projectId: "demo", sourceHash: "x", requestHash: "x",
      createdAt: new Date().toISOString(), mode: "snapshot", path: root, codex: { attempted: false, ok: false },
    }));
    await expect(loadStage(options, stageId)).rejects.toThrow(/escaped/);
  });
});

describe("approval state machine", () => {
  it("binds approvals to owner and blocks replay", async () => {
    const { service } = await fixture();
    const approval = await service.prepare({ projectId: "demo", kind: "develop", request: "make a safe change", actor: owner });
    await service.decide(approval.id, "deny", owner);
    await expect(service.decide(approval.id, "allow", owner)).rejects.toThrow(/already denied/);
  });

  it("expires an approval after ten minutes", async () => {
    let clock = new Date("2026-07-22T00:00:00.000Z");
    const { service } = await fixture(() => clock);
    const approval = await service.prepare({ projectId: "demo", kind: "develop", request: "test expiry", actor: owner });
    clock = new Date("2026-07-22T00:10:00.001Z");
    await expect(service.decide(approval.id, "allow", owner)).rejects.toThrow(/expired/);
  });

  it("blocks execution when source content changes after approval", async () => {
    const { service, project } = await fixture();
    const approval = await service.prepare({ projectId: "demo", kind: "develop", request: "test source binding", actor: owner });
    await service.decide(approval.id, "allow", owner);
    await writeFile(path.join(project, "app.txt"), "changed after approval\n");
    const failed = await executeToTerminal(service, approval.id);
    expect(failed).toMatchObject({ state: "failed", failure: expect.stringMatching(/changed after preview/) });
  });

  it("uses an approval only once and stages without touching live files", async () => {
    const { service, project } = await fixture();
    const approval = await service.prepare({ projectId: "demo", kind: "develop", request: "stage this task", actor: owner });
    await service.decide(approval.id, "allow", owner);
    const executed = await executeToTerminal(service, approval.id);
    expect(executed.state).toBe("executed");
    expect(await readFile(path.join(project, "app.txt"), "utf8")).toBe("initial\n");
    await expect(service.execute(approval.id, owner)).rejects.toThrow(/is executed/);
  });

  it("returns running immediately, heartbeats, and rejects a concurrent replay", async () => {
    const { root, options, service } = await fixture();
    const runner = path.join(root, "slow-runner.js");
    await writeFile(
      runner,
      'setTimeout(() => process.stdout.write(JSON.stringify({ authenticated: true, models: 1, summary: "done" })), 150);\n',
    );
    options.codexRunner = runner;
    options.heartbeatIntervalMs = 10;
    options.leaseDurationMs = 50;
    const approval = await service.prepare({
      projectId: "demo", kind: "develop", request: "exercise asynchronous execution", actor: owner,
    });
    await service.decide(approval.id, "allow", owner);

    const accepted = await service.execute(approval.id, owner);
    expect(accepted.state).toBe("running");
    await expect(service.execute(approval.id, owner)).rejects.toThrow(/is running/);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const heartbeat = await service.load(approval.id);
    expect(Date.parse(heartbeat.heartbeatAt!)).toBeGreaterThanOrEqual(Date.parse(accepted.heartbeatAt!));
    expect(Date.parse(heartbeat.leaseExpiresAt!)).toBeGreaterThan(Date.parse(heartbeat.heartbeatAt!));
    await expect(service.waitForTerminal(approval.id)).resolves.toMatchObject({ state: "executed" });
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("recovers an allowed approval after broker startup without a second owner decision", async () => {
    const { options, service } = await fixture();
    const approval = await service.prepare({
      projectId: "demo", kind: "develop", request: "recover an allowed approval", actor: owner,
    });
    await service.decide(approval.id, "allow", owner);
    const restarted = new ApprovalService(options);
    await restarted.start();
    try {
      await expect(restarted.waitForTerminal(approval.id)).resolves.toMatchObject({
        state: "executed",
        recoveryCount: 0,
      });
    } finally {
      restarted.stop();
    }
  });

  it("recovers one orphaned running attempt and replaces its stale isolated stage", async () => {
    const { options, service } = await fixture();
    const approval = await service.prepare({
      projectId: "demo", kind: "develop", request: "recover an orphaned worker", actor: owner,
    });
    await service.decide(approval.id, "allow", owner);
    const stageId = "11111111-1111-4111-8111-111111111111";
    const staleStage = path.join(options.dataDir, "staging", stageId);
    await mkdir(staleStage, { recursive: true });
    await writeFile(path.join(staleStage, "stale.txt"), "orphan\n");
    const record = await service.load(approval.id);
    Object.assign(record, {
      state: "running",
      stageId,
      diagnosticStageId: stageId,
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 1_000).toISOString(),
      executionDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
      attemptId: "22222222-2222-4222-8222-222222222222",
      leaseOwner: "stopped-broker",
      leaseExpiresAt: new Date(Date.now() - 1).toISOString(),
      recoveryCount: 0,
    });
    await writeFile(
      path.join(options.dataDir, "approvals", `${approval.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );

    const restarted = new ApprovalService(options);
    await restarted.start();
    try {
      const terminal = await restarted.waitForTerminal(approval.id);
      expect(terminal).toMatchObject({ state: "executed", recoveryCount: 1, stageId });
      await expect(stat(path.join(staleStage, "stale.txt"))).rejects.toThrow();
      await expect(stat(path.join(staleStage, "app.txt"))).resolves.toBeTruthy();
    } finally {
      restarted.stop();
    }
  });

  it("enforces one total execution timeout and persists a bounded timeout diagnostic", async () => {
    const { root, options, service } = await fixture();
    const runner = path.join(root, "timeout-runner.js");
    await writeFile(
      runner,
      'setTimeout(() => process.stdout.write(JSON.stringify({ authenticated: true, models: 1, summary: "late" })), 5_000);\n',
    );
    options.codexRunner = runner;
    options.executionTimeoutMs = 75;
    const approval = await service.prepare({
      projectId: "demo", kind: "develop", request: "time out safely", actor: owner,
    });
    await service.decide(approval.id, "allow", owner);
    const failed = await executeToTerminal(service, approval.id);
    expect(failed).toMatchObject({ state: "failed", failure: expect.stringMatching(/failed|timeout/i) });
    await expect(service.failureResult(approval.id, owner)).resolves.toMatchObject({
      state: "failed",
      sandboxStage: "execution-timeout",
    });
  });

  it("keeps clean-Git stage metadata inside the isolated staging directory", async () => {
    const { project, options, service } = await cleanGitFixture(["/usr/bin/python3", "-c", "pass"]);
    const approval = await service.prepare({
      projectId: "demo",
      kind: "develop",
      request: "create an isolated stage",
      actor: owner,
    });
    await service.decide(approval.id, "allow", owner);
    const record = await executeToTerminal(service, approval.id);
    const stageId = (record.result as { id: string }).id;
    const stage = await loadStage(options, stageId);

    expect(stage.mode).toBe("isolated-git");
    expect((await stat(path.join(stage.path, ".git"))).isDirectory()).toBe(true);
    const worktrees = await runCommand([
      "/usr/bin/git", "-c", `safe.directory=${project}`, "-C", project, "worktree", "list", "--porcelain",
    ]);
    expect(worktrees.stdout).not.toContain(stage.id);
  });

  it("persists a bounded Codex failure diagnostic before removing its isolated Git stage", async () => {
    const { root, project, options, service } = await cleanGitFixture(["/usr/bin/python3", "-c", "pass"]);
    const codexHome = path.join(root, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await mkdir(path.join(options.dataDir, "tmp"), { recursive: true });
    const runner = path.join(root, "failing-runner.js");
    const credentialSentinel = "test-managed-auth-secret-1234567890";
    await writeFile(
      runner,
      `process.stderr.write("Authorization: Bearer ${credentialSentinel}\\n"); process.exit(78);\n`,
    );
    options.codexExecutable = "/usr/bin/false";
    options.codexRunner = runner;
    options.codexHome = codexHome;
    options.codexAgentDir = root;
    options.codexConfigPath = path.join(root, "openclaw.json");
    options.serviceUid = process.getuid();
    options.serviceGid = process.getgid();
    const request = "private failure-path request";
    const approval = await service.prepare({ projectId: "demo", kind: "develop", request, actor: owner });
    await service.decide(approval.id, "allow", owner);

    const terminal = await executeToTerminal(service, approval.id);
    expect(terminal).toMatchObject({ state: "failed", failure: expect.stringMatching(/Codex staging task failed/) });

    const taskFiles = (await readdir(path.join(options.dataDir, "tasks"))).filter((name) => name.endsWith(".failure.json"));
    expect(taskFiles).toHaveLength(1);
    const diagnostic = JSON.parse(
      await readFile(path.join(options.dataDir, "tasks", taskFiles[0]!), "utf8"),
    ) as Record<string, unknown>;
    const { resultHash, ...payload } = diagnostic;
    expect(diagnostic).toMatchObject({
      schemaVersion: 1,
      approvalId: approval.id,
      sandboxStage: "authentication",
      exitCode: 78,
      signal: null,
      stdout: "",
      outputTruncated: false,
      stageExistedAtCapture: true,
    });
    expect(diagnostic.createdAt).toEqual(expect.any(String));
    expect(diagnostic.stageId).toMatch(/^[a-f0-9-]{36}$/);
    expect(resultHash).toBe(sha256(JSON.stringify(payload)));
    expect(JSON.stringify(diagnostic)).not.toContain(request);
    expect(JSON.stringify(diagnostic)).not.toContain(credentialSentinel);
    const failedRecord = await service.load(approval.id);
    expect(failedRecord.stageId).toBe(diagnostic.stageId);
    await expect(service.failureResult(approval.id, owner)).resolves.toMatchObject({
      approvalId: approval.id,
      stageId: diagnostic.stageId,
      state: "failed",
      sandboxStage: "authentication",
      exitCode: 78,
      signal: null,
    });
    await expect(stat(path.join(options.dataDir, "staging", String(diagnostic.stageId)))).rejects.toThrow();
    const worktrees = await runCommand([
      "/usr/bin/git", "-c", `safe.directory=${project}`, "-C", project, "worktree", "list", "--porcelain",
    ]);
    expect(worktrees.code).toBe(0);
    expect(worktrees.stdout).not.toContain(String(diagnostic.stageId));
    expect(await readFile(path.join(project, "app.txt"), "utf8")).toBe("initial\n");
  });

  it("persists process-spawn failures with null exit status before cleanup", async () => {
    const { root, project, options, service } = await cleanGitFixture(["/usr/bin/python3", "-c", "pass"]);
    const codexHome = path.join(root, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await mkdir(path.join(options.dataDir, "tmp"), { recursive: true });
    options.codexExecutable = path.join(root, "missing-codex");
    options.codexRunner = path.join(root, "missing-runner.js");
    options.codexHome = codexHome;
    options.codexAgentDir = root;
    options.codexConfigPath = path.join(root, "openclaw.json");
    options.serviceUid = process.getuid();
    options.serviceGid = process.getgid();
    const approval = await service.prepare({ projectId: "demo", kind: "develop", request: "spawn failure", actor: owner });
    await service.decide(approval.id, "allow", owner);

    const terminal = await executeToTerminal(service, approval.id);
    expect(terminal).toMatchObject({ state: "failed", failure: expect.stringMatching(/Codex staging task failed/) });

    const taskFiles = (await readdir(path.join(options.dataDir, "tasks"))).filter((name) => name.endsWith(".failure.json"));
    expect(taskFiles).toHaveLength(1);
    const diagnostic = JSON.parse(
      await readFile(path.join(options.dataDir, "tasks", taskFiles[0]!), "utf8"),
    ) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      approvalId: approval.id,
      sandboxStage: "task-execution",
      exitCode: 1,
      signal: null,
      stdout: "",
      stageExistedAtCapture: true,
    });
    expect(String(diagnostic.stderr)).not.toContain("spawn ENOENT");
    await expect(stat(path.join(options.dataDir, "staging", String(diagnostic.stageId)))).rejects.toThrow();
    const worktrees = await runCommand([
      "/usr/bin/git", "-c", `safe.directory=${project}`, "-C", project, "worktree", "list", "--porcelain",
    ]);
    expect(worktrees.stdout).not.toContain(String(diagnostic.stageId));
  });

  it("keeps managed auth out of child environment and returns only a bounded summary", async () => {
    let notificationHandler: ((notification: Record<string, unknown>) => void) | undefined;
    const result = await runCodexRunner({
      codexExecutable: "/usr/bin/codex",
      codexHome: "/tmp/codex-home",
      agentDir: "/tmp/agent",
      cwd: "/tmp/stage",
      request: "safe test request",
      clientFactory: async ({ startOptions }) => {
        expect(startOptions.env).not.toHaveProperty("OPENAI_API_KEY");
        expect(startOptions.env).not.toHaveProperty("CODEX_API_KEY");
        expect(startOptions.clearEnv).toEqual(expect.arrayContaining(["OPENAI_API_KEY", "CODEX_API_KEY"]));
        return {
          async request(method: string) {
            if (method === "model/list") {
              return { data: [{ model: "gpt-test", isDefault: true }] };
            }
            if (method === "thread/start") return { thread: { id: "thread-1" } };
            if (method === "turn/start") {
              queueMicrotask(() => {
                notificationHandler?.({
                  method: "item/completed",
                  params: {
                    threadId: "thread-1",
                    turnId: "turn-1",
                    item: { id: "answer", type: "agentMessage", text: "validated" },
                  },
                });
                notificationHandler?.({
                  method: "turn/completed",
                  params: { threadId: "thread-1", turnId: "turn-1", turn: { status: "completed" } },
                });
              });
              return { turn: { id: "turn-1" } };
            }
            throw new Error(`unexpected method: ${method}`);
          },
          addNotificationHandler(handler) {
            notificationHandler = handler;
            return () => { notificationHandler = undefined; };
          },
          addRequestHandler() {
            return () => undefined;
          },
          close() {},
        };
      },
    });

    expect(result).toEqual({ authenticated: true, models: 1, summary: "validated" });
    expect(JSON.stringify(result)).not.toMatch(/authorization|bearer|token|secret/i);
  });

  it("returns only the owner-bound, allowlisted failure result fields", async () => {
    const { service } = await fixture();
    const approval = await service.prepare({
      projectId: "demo", kind: "develop", request: "query failure result", actor: owner,
    });
    const stageId = "11111111-1111-4111-8111-111111111111";
    await persistFailureFixture(service, approval.id, stageId);

    const result = await service.failureResult(approval.id, owner);

    expect(Object.keys(result).sort()).toEqual([
      "approvalId", "createdAt", "exitCode", "resultHash", "sandboxStage",
      "signal", "stageId", "state", "stderr", "stdout",
    ].sort());
    expect(result).toMatchObject({
      approvalId: approval.id,
      stageId,
      state: "failed",
      sandboxStage: "task-execution",
      exitCode: 7,
      signal: null,
      stdout: "bounded stdout",
      stderr: "bounded stderr",
      createdAt: "2026-07-26T08:00:00.000Z",
    });
  });

  it("rejects non-owner and mismatched actors when reading a failure result", async () => {
    const { service } = await fixture();
    const approval = await service.prepare({
      projectId: "demo", kind: "develop", request: "owner-only result", actor: owner,
    });
    await persistFailureFixture(service, approval.id, "22222222-2222-4222-8222-222222222222");

    await expect(service.failureResult(approval.id, {
      ...owner,
      senderIsOwner: false,
    })).rejects.toThrow(/only the bound/);
    await expect(service.failureResult(approval.id, {
      ...owner,
      senderId: "wx-other",
    })).rejects.toThrow(/only the bound/);
  });

  it("returns a stable not-found error for an unknown approval", async () => {
    const { service } = await fixture();
    await expect(
      service.failureResult("33333333-3333-4333-8333-333333333333", owner),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND", statusCode: 404 });
  });

  it("rejects cross-approval failure result binding", async () => {
    const { service } = await fixture();
    const first = await service.prepare({
      projectId: "demo", kind: "develop", request: "first result", actor: owner,
    });
    const second = await service.prepare({
      projectId: "demo", kind: "develop", request: "second result", actor: owner,
    });
    const firstStage = "44444444-4444-4444-8444-444444444444";
    const secondStage = "55555555-5555-4555-8555-555555555555";
    await persistFailureFixture(service, first.id, firstStage);
    await persistFailureFixture(service, second.id, secondStage);
    const firstRecord = await service.load(first.id);
    firstRecord.state = "failed";
    firstRecord.stageId = secondStage;
    await writeFile(
      path.join(service.options.dataDir, "approvals", `${first.id}.json`),
      `${JSON.stringify(firstRecord, null, 2)}\n`,
    );

    await expect(service.failureResult(first.id, owner)).rejects.toMatchObject({
      code: "FAILURE_RESULT_INVALID",
    });
  });

  it("rejects traversal in a persisted stage binding before reading any path", async () => {
    const { service } = await fixture();
    const approval = await service.prepare({
      projectId: "demo", kind: "develop", request: "traversal result", actor: owner,
    });
    const record = await service.load(approval.id);
    record.state = "failed";
    record.stageId = "../outside";
    await writeFile(
      path.join(service.options.dataDir, "approvals", `${approval.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );

    await expect(service.failureResult(approval.id, owner)).rejects.toMatchObject({
      code: "INVALID_IDENTIFIER",
    });
  });

  it("re-redacts persisted diagnostics before returning them", async () => {
    const { service } = await fixture();
    const approval = await service.prepare({
      projectId: "demo", kind: "develop", request: "redaction result", actor: owner,
    });
    const stageId = "66666666-6666-4666-8666-666666666666";
    await persistFailureFixture(service, approval.id, stageId, {
      stdout: [
        "TOKEN=not-a-real-token-value",
        "owner=wxid_private_owner",
        "path=/home/real-user/project",
      ].join("\n"),
      stderr: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    });

    const result = await service.failureResult(approval.id, owner);
    const serialized = JSON.stringify(result);
    expect(result.stdout).toContain("[REDACTED_ENV]");
    expect(result.stdout).toContain("[REDACTED_IDENTITY]");
    expect(result.stdout).toContain("/[REDACTED_HOME]/project");
    expect(result.stderr).toContain("[REDACTED]");
    expect(serialized).not.toContain("not-a-real-token-value");
    expect(serialized).not.toContain("wxid_private_owner");
    expect(serialized).not.toContain("real-user");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("applies a tested isolated Git change and rolls it back with fresh approvals", async () => {
    const testCommand = ["/usr/bin/python3", "-c", "pass"];
    const { service, project } = await cleanGitFixture(testCommand);
    const develop = await service.prepare({ projectId: "demo", kind: "develop", request: "change the fixture", actor: owner });
    await service.decide(develop.id, "allow", owner);
    const developed = await executeToTerminal(service, develop.id);
    const stage = developed.result as { id: string; path: string };
    await writeFile(path.join(stage.path, "app.txt"), "staged\n");
    expect(await readFile(path.join(project, "app.txt"), "utf8")).toBe("initial\n");

    const apply = await service.prepare({
      projectId: "demo", kind: "apply", request: "apply tested fixture", stageId: stage.id, actor: owner,
    });
    await service.decide(apply.id, "allow", owner);
    const applied = await executeToTerminal(service, apply.id);
    const rollbackId = (applied.result as { rollbackId: string }).rollbackId;
    expect(await readFile(path.join(project, "app.txt"), "utf8")).toBe("staged\n");
    await expect(service.prepare({
      projectId: "demo", kind: "apply", request: "replay must fail", stageId: stage.id, actor: owner,
    })).rejects.toMatchObject({ code: "STAGE_ALREADY_BOUND" });

    const rollback = await service.prepare({
      projectId: "demo", kind: "rollback", request: "restore fixture", snapshotId: rollbackId, actor: owner,
    });
    await service.decide(rollback.id, "allow", owner);
    await executeToTerminal(service, rollback.id);
    expect(await readFile(path.join(project, "app.txt"), "utf8")).toBe("initial\n");
    await expect(service.prepare({
      projectId: "demo", kind: "rollback", request: "rollback replay", snapshotId: rollbackId, actor: owner,
    })).rejects.toMatchObject({ code: "ROLLBACK_REPLAY" });

    const audit = await readFile(path.join(service.options.dataDir, "logs", "ops-audit.jsonl"), "utf8");
    expect(audit).not.toContain("change the fixture");
    expect(audit).not.toContain("staged\\n");
  });

  it("uses the service-private /tmp bundle path even when broker data/tmp is not traversable by live", async () => {
    if (process.getuid() !== 0) return;
    const { service, project, options } = await cleanGitFixture(["/usr/bin/python3", "-c", "pass"]);
    await chmod(path.join(options.dataDir, "tmp"), 0o700);
    const develop = await service.prepare({
      projectId: "demo", kind: "develop", request: "private tmp transfer fixture", actor: owner,
    });
    await service.decide(develop.id, "allow", owner);
    const developed = await executeToTerminal(service, develop.id);
    const stage = developed.result as { id: string; path: string };
    await writeFile(path.join(stage.path, "app.txt"), "staged\n");
    const apply = await service.prepare({
      projectId: "demo", kind: "apply", request: "import through private tmp",
      stageId: stage.id, actor: owner,
    });
    await service.decide(apply.id, "allow", owner);
    const applied = await executeToTerminal(service, apply.id);

    expect(applied.state).toBe("executed");
    expect(await readFile(path.join(project, "app.txt"), "utf8")).toBe("staged\n");
  });

  it("restores a pre-commit binding to ready when candidate bundle import fails", async () => {
    const { root, service, project, options } = await cleanGitFixture(["/usr/bin/python3", "-c", "pass"]);
    options.applyBundleDirectory = path.join(root, "missing-transfer-directory");
    const develop = await service.prepare({
      projectId: "demo", kind: "develop", request: "failed import fixture", actor: owner,
    });
    await service.decide(develop.id, "allow", owner);
    const developed = await executeToTerminal(service, develop.id);
    const stage = developed.result as { id: string; path: string };
    await writeFile(path.join(stage.path, "app.txt"), "staged\n");
    const apply = await service.prepare({
      projectId: "demo", kind: "apply", request: "fail before cherry-pick",
      stageId: stage.id, actor: owner,
    });
    await service.decide(apply.id, "allow", owner);
    const failed = await executeToTerminal(service, apply.id);
    const binding = await readApplyBinding(options, stage.id);

    expect(failed.state).toBe("failed");
    expect(binding).toMatchObject({ state: "ready" });
    expect(binding.liveCommit).toBeUndefined();
    expect(await readFile(path.join(project, "app.txt"), "utf8")).toBe("initial\n");
  });

  it("recovers a legacy failed applying binding on broker restart only when live is unchanged", async () => {
    const fixture = await failedApplyFixture([["/usr/bin/python3", "-c", "raise SystemExit(7)"]]);
    const binding = await readApplyBinding(fixture.options, fixture.stage.id);
    binding.state = "applying";
    await writeApplyBinding(fixture.options, fixture.stage.id, binding);
    const restarted = new ApprovalService(fixture.options);

    await restarted.start();
    try {
      expect(await readApplyBinding(fixture.options, fixture.stage.id)).toMatchObject({
        applyApprovalId: fixture.apply.id,
        state: "ready",
      });
      expect((await readApplyBinding(fixture.options, fixture.stage.id)).liveCommit).toBeUndefined();
      expect(await readFile(path.join(fixture.project, "app.txt"), "utf8")).toBe("initial\n");
    } finally {
      restarted.stop();
    }
  });

  it("blocks apply when the fixed test recipe fails", async () => {
    const { service, project } = await cleanGitFixture(["/usr/bin/python3", "-c", "raise SystemExit(7)"]);
    const develop = await service.prepare({ projectId: "demo", kind: "develop", request: "stage failure fixture", actor: owner });
    await service.decide(develop.id, "allow", owner);
    const developed = await executeToTerminal(service, develop.id);
    const stage = developed.result as { id: string; path: string };
    await writeFile(path.join(stage.path, "app.txt"), "staged\n");
    const apply = await service.prepare({
      projectId: "demo", kind: "apply", request: "this must fail", stageId: stage.id, actor: owner,
    });
    await service.decide(apply.id, "allow", owner);
    const failed = await executeToTerminal(service, apply.id);
    expect(failed).toMatchObject({
      state: "failed",
      failure: expect.stringMatching(/stage-pre-apply validation command 1 failed: exit code 7/),
    });
    expect(await readFile(path.join(project, "app.txt"), "utf8")).toBe("initial\n");
  });

  it.each([1, 2, 3])(
    "records the exact fixed validation command when command %i fails",
    async (failedCommandIndex) => {
      const commands = [1, 2, 3].map((index) => [
        "/usr/bin/python3",
        "-c",
        index === failedCommandIndex ? `raise SystemExit(${10 + index})` : "pass",
      ]);
      const { service, project, develop, stage, apply, failed, options } = await failedApplyFixture(commands);
      const result = await service.failureResult(apply.id, owner);
      const binding = await readApplyBinding(options, stage.id);
      const approval = await service.load(apply.id);

      expect(failed.failure).toContain(`validation command ${failedCommandIndex} failed`);
      expect(result).toMatchObject({
        approvalId: apply.id,
        stageId: stage.id,
        state: "failed",
        sandboxStage: "apply-validation",
        developApprovalId: develop.id,
        candidateCommit: binding.candidateCommit,
        validationPhase: "stage-pre-apply",
        exitCode: 10 + failedCommandIndex,
        timeout: false,
      });
      expect(result.validationResults).toHaveLength(failedCommandIndex);
      expect(result.validationResults?.at(-1)).toMatchObject({
        commandIndex: failedCommandIndex,
        commandId: expect.stringMatching(/^[a-f0-9]{64}$/),
        exitCode: 10 + failedCommandIndex,
        signal: null,
        timeout: false,
        cwd: `stage:${stage.id}`,
        uid: options.serviceUid,
        gid: options.serviceGid,
        resultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(approval.diagnosticStageId).toBe(stage.id);
      await expect(stat(path.join(options.dataDir, "tasks", `${apply.id}.failure.json`))).resolves.toBeTruthy();
      expect(binding.state).toBe("ready");
      expect(await readFile(path.join(project, "app.txt"), "utf8")).toBe("initial\n");
    },
  );

  it("records validation timeout and signal without changing live", async () => {
    const timed = await failedApplyFixture(
      [["/usr/bin/python3", "-c", "import time; time.sleep(5)"]],
      (options) => { options.applyValidationTimeoutMs = 25; },
    );
    const timeoutResult = await timed.service.failureResult(timed.apply.id, owner);
    expect(timeoutResult).toMatchObject({
      stageId: timed.stage.id,
      validationPhase: "stage-pre-apply",
      exitCode: null,
      signal: "SIGTERM",
      timeout: true,
    });
    expect(timeoutResult.validationResults?.[0]).toMatchObject({
      commandIndex: 1,
      exitCode: null,
      signal: "SIGTERM",
      timeout: true,
    });
    expect(await readFile(path.join(timed.project, "app.txt"), "utf8")).toBe("initial\n");

    const signaled = await failedApplyFixture([[
      "/usr/bin/python3", "-c", "import os, signal; os.kill(os.getpid(), signal.SIGTERM)",
    ]]);
    const signalResult = await signaled.service.failureResult(signaled.apply.id, owner);
    expect(signalResult).toMatchObject({
      stageId: signaled.stage.id,
      exitCode: null,
      signal: "SIGTERM",
      timeout: false,
    });
    expect(await readFile(path.join(signaled.project, "app.txt"), "utf8")).toBe("initial\n");
  });

  it("redacts and truncates fixed validation stdout and stderr before persistence", async () => {
    const stdoutSecret = "not-a-real-validation-token-1234567890";
    const stderrSecret = "abcdefghijklmnopqrstuvwxyz123456";
    const command = [
      "/usr/bin/python3",
      "-c",
      [
        "import sys",
        `print("TOKEN=${stdoutSecret}")`,
        `sys.stderr.write("Authorization: Bearer ${stderrSecret}\\n" + "x" * 4096)`,
        "raise SystemExit(9)",
      ].join("; "),
    ];
    const { service, apply, options } = await failedApplyFixture(
      [command],
      (settings) => { settings.applyValidationMaxOutputBytes = 256; },
    );
    const result = await service.failureResult(apply.id, owner);
    const serialized = JSON.stringify(result);
    const commandResult = result.validationResults?.[0]!;
    const { resultHash, ...payload } = commandResult;

    expect(commandResult.outputTruncated).toBe(true);
    expect(commandResult.stdout).toContain("[REDACTED_ENV]");
    expect(commandResult.stderr).toContain("[REDACTED]");
    expect(serialized).not.toContain(stdoutSecret);
    expect(serialized).not.toContain(stderrSecret);
    expect(serialized).not.toContain("Authorization: Bearer");
    expect(resultHash).toBe(sha256(JSON.stringify(payload)));
    const persisted = await readFile(
      path.join(options.dataDir, "tasks", `${apply.id}.failure.json`),
      "utf8",
    );
    expect(persisted).not.toContain(stdoutSecret);
    expect(persisted).not.toContain(stderrSecret);
  });

  it("rebinds one unchanged ready candidate to a new pending approval and preserves the failed approval", async () => {
    const fixture = await failedApplyFixture([["/usr/bin/python3", "-c", "raise SystemExit(7)"]]);
    const before = await readApplyBinding(fixture.options, fixture.stage.id);
    before.schemaVersion = 1;
    delete before.validationRecipeHash;
    await writeApplyBinding(fixture.options, fixture.stage.id, before);
    const demo = getProject(await loadRegistry(fixture.options.registryPath), "demo");
    await expect(inspectApplyRetryEligibility(
      fixture.options,
      demo,
      fixture.stage.id,
    )).resolves.toMatchObject({
      eligible: true,
      failedApplyApprovalId: fixture.apply.id,
      candidateCommit: before.candidateCommit,
      bindingState: "ready",
    });
    expect((await readApplyBinding(fixture.options, fixture.stage.id)).applyApprovalId).toBe(fixture.apply.id);
    const retry = await fixture.service.prepare({
      projectId: "demo",
      kind: "apply",
      request: "retry the unchanged failed candidate",
      stageId: fixture.stage.id,
      actor: owner,
    });
    const after = await readApplyBinding(fixture.options, fixture.stage.id);

    expect(retry).toMatchObject({
      state: "pending",
      stageId: fixture.stage.id,
      preview: expect.objectContaining({
        retry: true,
        previousApplyApprovalId: fixture.apply.id,
        candidateCommit: before.candidateCommit,
        candidateTree: before.candidateTree,
        commitDiffHash: before.commitDiffHash,
        developResultHash: before.developResultHash,
        validationRecipeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        recipeId: "legacy-default",
        recipeVersion: 1,
        recipeConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(after).toMatchObject({
      schemaVersion: 3,
      state: "ready",
      applyApprovalId: retry.id,
      previousApplyApprovalId: fixture.apply.id,
      candidateCommit: before.candidateCommit,
      candidateTree: before.candidateTree,
      commitDiffHash: before.commitDiffHash,
      developResultHash: before.developResultHash,
      recipeId: "legacy-default",
      recipeVersion: 1,
      recipeConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      rebindCount: 1,
    });
    expect(await fixture.service.load(fixture.apply.id)).toMatchObject({ state: "failed" });
    expect(await readFile(path.join(fixture.project, "app.txt"), "utf8")).toBe("initial\n");
  });

  it("rejects retry when live changed, the binding is not ready, or the candidate was tampered", async () => {
    const liveChanged = await failedApplyFixture([["/usr/bin/python3", "-c", "raise SystemExit(7)"]]);
    await writeFile(path.join(liveChanged.project, "app.txt"), "live drift\n");
    await expect(liveChanged.service.prepare({
      projectId: "demo", kind: "apply", request: "reject live drift",
      stageId: liveChanged.stage.id, actor: owner,
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });

    const notReady = await failedApplyFixture([["/usr/bin/python3", "-c", "raise SystemExit(7)"]]);
    const nonReadyBinding = await readApplyBinding(notReady.options, notReady.stage.id);
    nonReadyBinding.state = "applying";
    await writeApplyBinding(notReady.options, notReady.stage.id, nonReadyBinding);
    await expect(notReady.service.prepare({
      projectId: "demo", kind: "apply", request: "reject applying binding",
      stageId: notReady.stage.id, actor: owner,
    })).rejects.toMatchObject({ code: "STAGE_ALREADY_BOUND" });

    const tampered = await failedApplyFixture([["/usr/bin/python3", "-c", "raise SystemExit(7)"]]);
    await writeFile(path.join(tampered.stage.path, "app.txt"), "tampered candidate\n");
    for (const argv of [
      ["/usr/bin/git", "-c", `safe.directory=${tampered.stage.path}`, "-C", tampered.stage.path, "add", "app.txt"],
      [
        "/usr/bin/git", "-c", `safe.directory=${tampered.stage.path}`, "-C", tampered.stage.path,
        "-c", "user.name=Project Ops", "-c", "user.email=project-ops@localhost",
        "commit", "--amend", "--no-edit", "--no-gpg-sign",
      ],
    ]) {
      const result = await runCommand(argv, {
        uid: tampered.options.serviceUid,
        gid: tampered.options.serviceGid,
      });
      expect(result.code, result.stderr).toBe(0);
    }
    await expect(tampered.service.prepare({
      projectId: "demo", kind: "apply", request: "reject candidate tamper",
      stageId: tampered.stage.id, actor: owner,
    })).rejects.toMatchObject({ code: "STAGE_TAMPERED" });

    const resultTampered = await failedApplyFixture([["/usr/bin/python3", "-c", "raise SystemExit(7)"]]);
    const resultBinding = await readApplyBinding(resultTampered.options, resultTampered.stage.id);
    resultBinding.developResultHash = "0".repeat(64);
    await writeApplyBinding(resultTampered.options, resultTampered.stage.id, resultBinding);
    await expect(resultTampered.service.prepare({
      projectId: "demo", kind: "apply", request: "reject result hash tamper",
      stageId: resultTampered.stage.id, actor: owner,
    })).rejects.toMatchObject({ code: "STAGE_RESULT_TAMPERED" });
  });

  it("allows only one concurrent retry rebind", async () => {
    const fixture = await failedApplyFixture([["/usr/bin/python3", "-c", "raise SystemExit(7)"]]);
    const competingService = new ApprovalService(fixture.options);
    const attempts = await Promise.allSettled([
      fixture.service.prepare({
        projectId: "demo", kind: "apply", request: "concurrent retry one",
        stageId: fixture.stage.id, actor: owner,
      }),
      competingService.prepare({
        projectId: "demo", kind: "apply", request: "concurrent retry two",
        stageId: fixture.stage.id, actor: owner,
      }),
    ]);
    const fulfilled = attempts.filter((entry) => entry.status === "fulfilled");
    const rejected = attempts.filter((entry) => entry.status === "rejected");
    const binding = await readApplyBinding(fixture.options, fixture.stage.id);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(binding.applyApprovalId).toBe((fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value.id);
    expect(await fixture.service.load(fixture.apply.id)).toMatchObject({ state: "failed" });
  });

  it("rejects apply when live sourceHash drifts from the executed stage baseline", async () => {
    const { service, project } = await cleanGitFixture(["/usr/bin/python3", "-c", "pass"]);
    const develop = await service.prepare({
      projectId: "demo", kind: "develop", request: "prepare drift fixture", actor: owner,
    });
    await service.decide(develop.id, "allow", owner);
    const developed = await executeToTerminal(service, develop.id);
    const stage = developed.result as { id: string; path: string };
    await writeFile(path.join(stage.path, "app.txt"), "staged\n");
    await writeFile(path.join(project, "app.txt"), "drifted\n");

    await expect(service.prepare({
      projectId: "demo", kind: "apply", request: "must reject drift", stageId: stage.id, actor: owner,
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("rejects a stage modified after its candidate commit was bound to an apply approval", async () => {
    const { service, project } = await cleanGitFixture(["/usr/bin/python3", "-c", "pass"]);
    const develop = await service.prepare({
      projectId: "demo", kind: "develop", request: "prepare tamper fixture", actor: owner,
    });
    await service.decide(develop.id, "allow", owner);
    const developed = await executeToTerminal(service, develop.id);
    const stage = developed.result as { id: string; path: string };
    await writeFile(path.join(stage.path, "app.txt"), "staged\n");
    const apply = await service.prepare({
      projectId: "demo", kind: "apply", request: "bind exact candidate", stageId: stage.id, actor: owner,
    });
    await writeFile(path.join(stage.path, "app.txt"), "tampered after binding\n");
    await service.decide(apply.id, "allow", owner);
    const failed = await executeToTerminal(service, apply.id);

    expect(failed).toMatchObject({ state: "failed", failure: expect.stringMatching(/not clean|modified|tamper/i) });
    expect(await readFile(path.join(project, "app.txt"), "utf8")).toBe("initial\n");
  });

  it("rejects a stage manifest that no longer matches its executed develop result", async () => {
    const { options, service } = await cleanGitFixture(["/usr/bin/python3", "-c", "pass"]);
    const develop = await service.prepare({
      projectId: "demo", kind: "develop", request: "prepare result tamper fixture", actor: owner,
    });
    await service.decide(develop.id, "allow", owner);
    const developed = await executeToTerminal(service, develop.id);
    const stage = developed.result as { id: string; path: string };
    await writeFile(path.join(stage.path, "app.txt"), "staged\n");
    const manifestPath = path.join(options.dataDir, "staging", `${stage.id}.json`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.sourceHash = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(service.prepare({
      projectId: "demo", kind: "apply", request: "reject tampered result", stageId: stage.id, actor: owner,
    })).rejects.toMatchObject({ code: "STAGE_RESULT_TAMPERED" });
  });

  it("rejects a stage presented through a different project binding", async () => {
    const { options, service } = await cleanGitFixture(["/usr/bin/python3", "-c", "pass"]);
    const develop = await service.prepare({
      projectId: "demo", kind: "develop", request: "prepare cross-project fixture", actor: owner,
    });
    await service.decide(develop.id, "allow", owner);
    const developed = await executeToTerminal(service, develop.id);
    const stage = developed.result as { id: string; path: string };
    await writeFile(path.join(stage.path, "app.txt"), "staged\n");
    const demo = getProject(await loadRegistry(options.registryPath), "demo");

    await expect(stagePreview(options, { ...demo, id: "other" }, stage.id, randomUUID()))
      .rejects.toMatchObject({ code: "APPLY_NOT_SUPPORTED" });
  });

  it("automatically reverts the live commit when fixed post-apply validation fails", async () => {
    const validation = [
      "/usr/bin/python3",
      "-c",
      [
        "from pathlib import Path",
        "is_live = Path.cwd().name == 'project'",
        "is_applied = Path('app.txt').read_text() == 'staged\\n'",
        "raise SystemExit(7 if is_live and is_applied else 0)",
      ].join("; "),
    ];
    const { service, project } = await cleanGitFixture(validation);
    const baseCommit = (await runCommand([
      "/usr/bin/git", "-c", `safe.directory=${project}`, "-C", project, "rev-parse", "HEAD",
    ])).stdout.trim();
    const develop = await service.prepare({
      projectId: "demo", kind: "develop", request: "prepare post-check rollback fixture", actor: owner,
    });
    await service.decide(develop.id, "allow", owner);
    const developed = await executeToTerminal(service, develop.id);
    const stage = developed.result as { id: string; path: string };
    await writeFile(path.join(stage.path, "app.txt"), "staged\n");
    const apply = await service.prepare({
      projectId: "demo", kind: "apply", request: "post-check must roll back", stageId: stage.id, actor: owner,
    });
    await service.decide(apply.id, "allow", owner);
    const failed = await executeToTerminal(service, apply.id);

    expect(failed).toMatchObject({
      state: "failed",
      failure: expect.stringMatching(/reverted/),
    });
    expect(await readFile(path.join(project, "app.txt"), "utf8")).toBe("initial\n");
    const log = await runCommand([
      "/usr/bin/git", "-c", `safe.directory=${project}`, "-C", project,
      "rev-list", "--count", `${baseCommit}..HEAD`,
    ]);
    expect(log.stdout.trim()).toBe("2");
    expect((await runCommand([
      "/usr/bin/git", "-c", `safe.directory=${project}`, "-C", project, "status", "--porcelain=v1",
    ])).stdout).toBe("");
  });

  it("reverts a recovered applying commit when its post-apply validation fails", async () => {
    const validation = [
      "/usr/bin/python3",
      "-c",
      [
        "from pathlib import Path",
        "is_live = Path.cwd().name == 'project'",
        "is_applied = Path('app.txt').read_text() == 'staged\\n'",
        "raise SystemExit(7 if is_live and is_applied else 0)",
      ].join("; "),
    ];
    const { options, service, project } = await cleanGitFixture(validation);
    const develop = await service.prepare({
      projectId: "demo", kind: "develop", request: "prepare interrupted apply fixture", actor: owner,
    });
    await service.decide(develop.id, "allow", owner);
    const developed = await executeToTerminal(service, develop.id);
    const stage = developed.result as { id: string; path: string };
    await writeFile(path.join(stage.path, "app.txt"), "staged\n");
    const apply = await service.prepare({
      projectId: "demo", kind: "apply", request: "recover interrupted apply", stageId: stage.id, actor: owner,
    });

    await writeFile(path.join(project, "app.txt"), "staged\n");
    for (const argv of [
      ["/usr/bin/git", "-c", `safe.directory=${project}`, "-C", project, "add", "--", "app.txt"],
      [
        "/usr/bin/git", "-c", `safe.directory=${project}`, "-C", project,
        "-c", "user.name=Project Ops", "-c", "user.email=project-ops@localhost",
        "commit", "--no-gpg-sign", "-m", "simulated interrupted project-ops apply",
      ],
    ]) {
      const result = await runCommand(argv, {
        uid: options.serviceUid === 0 ? 65_534 : options.serviceUid,
        gid: options.serviceGid === 0 ? 65_534 : options.serviceGid,
      });
      expect(result.code, result.stderr).toBe(0);
    }
    const bindingPath = path.join(options.dataDir, "staging", `${stage.id}.apply.json`);
    const binding = JSON.parse(await readFile(bindingPath, "utf8")) as Record<string, unknown>;
    delete binding.bindingHash;
    binding.state = "applying";
    binding.bindingHash = sha256(JSON.stringify(binding));
    await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);

    await service.decide(apply.id, "allow", owner);
    const failed = await executeToTerminal(service, apply.id);

    expect(failed).toMatchObject({
      state: "failed",
      failure: expect.stringMatching(/reverted/),
    });
    expect(await readFile(path.join(project, "app.txt"), "utf8")).toBe("initial\n");
    expect((await runCommand([
      "/usr/bin/git", "-c", `safe.directory=${project}`, "-C", project, "status", "--porcelain=v1",
    ])).stdout).toBe("");
  });
});
import { randomUUID } from "node:crypto";
