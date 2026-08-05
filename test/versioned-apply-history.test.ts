import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService } from "../src/ops/approvals.js";
import { runCommand } from "../src/ops/process.js";
import { sha256 } from "../src/ops/security.js";
import type { Actor, ApprovalRecord, BrokerOptions } from "../src/ops/types.js";

const roots: string[] = [];
const owner: Actor = {
  senderId: "wx-owner-history",
  channel: "openclaw-weixin",
  senderIsOwner: true,
};

async function executeToTerminal(
  service: ApprovalService,
  approvalId: string,
): Promise<ApprovalRecord> {
  expect((await service.execute(approvalId, owner)).state).toBe("running");
  const terminal = await service.waitForTerminal(approvalId);
  await new Promise((resolve) => setImmediate(resolve));
  return terminal;
}

async function fixture(): Promise<{
  service: ApprovalService;
  options: BrokerOptions;
  project: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "versioned-apply-history-"));
  roots.push(root);
  await chmod(root, 0o755);
  const project = path.join(root, "project");
  const frontend = path.join(project, "frontend");
  const tests = path.join(frontend, "tests");
  const dataDir = path.join(root, "data");
  await mkdir(tests, { recursive: true });
  await mkdir(path.join(dataDir, "tmp"), { recursive: true });
  await writeFile(path.join(tests, "Work.test.tsx"), "initial\n");
  await writeFile(path.join(frontend, "runner.mjs"), "process.exit(0);\n");
  await writeFile(path.join(frontend, "package.json"), `${JSON.stringify({
    name: "b1-history-fixture",
    version: "1.0.0",
    private: true,
    scripts: {
      test: "node runner.mjs",
      typecheck: "node runner.mjs",
      lint: "node runner.mjs",
    },
  }, null, 2)}\n`);
  await writeFile(path.join(frontend, "package-lock.json"), `${JSON.stringify({
    name: "b1-history-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "b1-history-fixture",
        version: "1.0.0",
      },
    },
  }, null, 2)}\n`);
  for (const argv of [
    ["/usr/bin/git", "init", "-q", project],
    ["/usr/bin/git", "-C", project, "config", "user.name", "ClawBot Test"],
    ["/usr/bin/git", "-C", project, "config", "user.email", "clawbot-test@localhost"],
    ["/usr/bin/git", "-C", project, "add", "."],
    ["/usr/bin/git", "-C", project, "commit", "-q", "-m", "fixture"],
  ]) {
    const command = await runCommand(argv);
    if (command.code !== 0) throw new Error(command.stderr);
  }
  const applyUid = process.getuid!() === 0 ? 65_534 : process.getuid!();
  const applyGid = process.getgid!() === 0 ? 65_534 : process.getgid!();
  if (process.getuid!() === 0) {
    const ownership = await runCommand([
      "/usr/bin/chown",
      "-R",
      `${applyUid}:${applyGid}`,
      project,
    ]);
    if (ownership.code !== 0) throw new Error(ownership.stderr);
  }
  const configDir = path.join(root, "config");
  await mkdir(configDir);
  const registryPath = path.join(configDir, "projects.yaml");
  await writeFile(registryPath, [
    "version: 2",
    "projects:",
    "  demo:",
    `    path: ${JSON.stringify(project)}`,
    "    sourceMode: clean-git",
    "    capabilities: [status, develop, apply, rollback]",
    "    status: []",
    "    actions: {}",
    "    apply:",
    "      selection: exact-changed-paths",
    "      recipes:",
    "        - id: s1-04b1",
    "          version: 1",
    "          allowedPaths: [frontend/tests/Work.test.tsx]",
    "          stageSetupProfiles: [s1-04b1-frontend-npm-ci@1]",
    "          validationProfiles: [s1-04b1-work-test@1, s1-04b1-typecheck@1, s1-04b1-lint@1]",
    `          uid: ${applyUid}`,
    `          gid: ${applyGid}`,
    "        - id: s1-04b2-1",
    "          version: 1",
    "          allowedPaths:",
    "            - backend/alembic/versions/0011_decisions_facts_risks.py",
    "            - backend/tests/database/test_migrations.py",
    "            - docs/17-s1-04b2-decisions-facts-risks.md",
    "          stageSetupProfiles: []",
    "          validationProfiles: [s1-04b2-1-db-check@1, s1-04b2-1-ruff-check@1, s1-04b2-1-ruff-format@1, s1-04b2-1-mypy@1]",
    `          uid: ${applyUid}`,
    `          gid: ${applyGid}`,
    "",
  ].join("\n"));
  const codexHome = path.join(root, "codex-home");
  await mkdir(codexHome);
  const runner = path.join(root, "runner.js");
  await writeFile(
    runner,
    'process.stdout.write(JSON.stringify({ authenticated: true, models: 1, summary: "validated" }));\n',
  );
  const options: BrokerOptions = {
    socketPath: path.join(dataDir, "broker.sock"),
    dataDir,
    registryPath,
    token: "history-test-token",
    ownerId: owner.senderId,
    maxOutputBytes: 1024 * 1024,
    approvalTtlMs: 10 * 60_000,
    codexExecutable: "/usr/bin/false",
    codexRunner: runner,
    codexHome,
    codexAgentDir: root,
    codexConfigPath: path.join(root, "openclaw.json"),
    serviceUid: process.getuid!(),
    serviceGid: process.getgid!(),
  };
  return { service: new ApprovalService(options), options, project };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("historical B1 schema 2 binding", () => {
  it("continues to apply and rollback after B2 is registered", async () => {
    const { service, options, project } = await fixture();
    const develop = await service.prepare({
      projectId: "demo",
      kind: "develop",
      request: "create historical B1 stage",
      actor: owner,
    });
    await service.decide(develop.id, "allow", owner);
    const developed = await executeToTerminal(service, develop.id);
    const stage = developed.result as { id: string; path: string };
    await writeFile(path.join(stage.path, "frontend/tests/Work.test.tsx"), "staged\n");

    const apply = await service.prepare({
      projectId: "demo",
      kind: "apply",
      request: "apply historical B1 binding",
      stageId: stage.id,
      actor: owner,
    });
    const bindingPath = path.join(options.dataDir, "staging", `${stage.id}.apply.json`);
    const binding = JSON.parse(await readFile(bindingPath, "utf8")) as Record<string, unknown>;
    delete binding.bindingHash;
    binding.schemaVersion = 2;
    delete binding.recipeId;
    delete binding.recipeVersion;
    delete binding.recipeConfigHash;
    binding.bindingHash = sha256(JSON.stringify(binding));
    await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`);

    await service.decide(apply.id, "allow", owner);
    const applied = await executeToTerminal(service, apply.id);
    expect(applied.state).toBe("executed");
    expect(await readFile(path.join(project, "frontend/tests/Work.test.tsx"), "utf8"))
      .toBe("staged\n");

    const rollbackId = (applied.result as { rollbackId: string }).rollbackId;
    const rollback = await service.prepare({
      projectId: "demo",
      kind: "rollback",
      request: "rollback historical B1 binding",
      snapshotId: rollbackId,
      actor: owner,
    });
    await service.decide(rollback.id, "allow", owner);
    expect((await executeToTerminal(service, rollback.id)).state).toBe("executed");
    expect(await readFile(path.join(project, "frontend/tests/Work.test.tsx"), "utf8"))
      .toBe("initial\n");
  }, 15_000);
});
