import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeApplyProfile,
  expandApplyProfiles,
  type ApplyProfileRunner,
} from "../src/ops/validation-profiles.js";
import type { BrokerOptions, CommandResult, ProjectConfig } from "../src/ops/types.js";

const roots: string[] = [];

function result(argv: readonly string[], overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    argv: [...argv],
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    durationMs: 1,
    ...overrides,
  };
}

async function context() {
  const root = await mkdtemp(path.join(os.tmpdir(), "apply-profile-test-"));
  roots.push(root);
  const live = path.join(root, "live");
  const dataDir = path.join(root, "data");
  const stage = path.join(dataDir, "staging", "11111111-1111-4111-8111-111111111111");
  await mkdir(live);
  await mkdir(stage, { recursive: true });
  const project: ProjectConfig = {
    id: "example-managed-app",
    path: live,
    realPath: await realpath(live),
    sourceMode: "clean-git",
    description: "",
    capabilities: ["apply"],
    status: [],
    actions: {},
  };
  const options: BrokerOptions = {
    socketPath: path.join(root, "broker.sock"),
    dataDir,
    registryPath: path.join(root, "projects.yaml"),
    token: "test-token",
    ownerId: "owner",
    maxOutputBytes: 1024,
    approvalTtlMs: 60_000,
  };
  return {
    options,
    project,
    cwd: stage,
    uid: 996,
    gid: 988,
    timeoutMs: 1234,
    maxOutputBytes: 2048,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("fixed validation profiles", () => {
  it("expands B1 argv byte-for-byte", () => {
    expect(expandApplyProfiles([
      "s1-04b1-work-test@1",
      "s1-04b1-typecheck@1",
      "s1-04b1-lint@1",
    ], "validation")).toEqual([
      [
        "/usr/bin/npm", "--prefix", "frontend", "test", "--", "--run",
        "tests/Work.test.tsx", "--configLoader", "runner",
      ],
      ["/usr/bin/npm", "--prefix", "frontend", "run", "typecheck"],
      ["/usr/bin/npm", "--prefix", "frontend", "run", "lint"],
    ]);
  });

  it("keeps the frozen Ruff format recipe argv while disabling its runtime cache", async () => {
    expect(expandApplyProfiles(
      ["s1-04b2-1-ruff-format@1"],
      "validation",
    )).toEqual([[
      "/usr/bin/docker",
      "compose",
      "run",
      "test",
      "ruff",
      "format",
      "--check",
      ".",
    ]]);
    const calls: string[][] = [];
    await executeApplyProfile(
      "s1-04b2-1-ruff-format@1",
      await context(),
      async (argv) => {
        calls.push([...argv]);
        return result(argv);
      },
    );
    expect(calls[0]!.slice(-5)).toEqual([
      "ruff",
      "format",
      "--no-cache",
      "--check",
      ".",
    ]);
  });

  it("uses fixed Docker argv without YAML-provided uid, gid, env or cwd", async () => {
    const calls: Array<{ argv: string[]; options: Record<string, unknown> }> = [];
    let overridePath = "";
    const runner: ApplyProfileRunner = async (argv, options) => {
      const home = options.env?.HOME;
      const dockerConfig = options.env?.DOCKER_CONFIG;
      const temporaryDirectory = options.env?.TMPDIR;
      expect(home).toMatch(/\/data\/tmp\/apply-docker\/run-[^/]+$/);
      expect(dockerConfig).toBe(path.join(home!, "docker"));
      expect(temporaryDirectory).toBe(path.join(home!, "tmp"));
      expect((await stat(home!)).mode & 0o777).toBe(0o700);
      expect((await stat(dockerConfig!)).mode & 0o777).toBe(0o700);
      expect((await stat(temporaryDirectory!)).mode & 0o777).toBe(0o700);
      await writeFile(path.join(dockerConfig!, "write-check"), "ok", { mode: 0o600 });
      const overrideIndex = argv.indexOf("--file", argv.indexOf("--file") + 1);
      overridePath = argv[overrideIndex + 1]!;
      expect(overridePath).toBe(path.join(home!, "compose.apply.yaml"));
      expect((await stat(overridePath)).mode & 0o777).toBe(0o600);
      expect(await readFile(overridePath, "utf8")).toBe([
        "services:",
        "  test:",
        "    user: \"996:988\"",
        "    environment:",
        "      HOME: /tmp",
        "    volumes:",
        "      - type: bind",
        "        source: ./backend",
        "        target: /app",
        "        read_only: true",
        "        bind:",
        "          create_host_path: false",
        "",
      ].join("\n"));
      calls.push({ argv: [...argv], options });
      return result(argv);
    };
    const execution = await executeApplyProfile(
      "s1-04b2-1-ruff-check@1",
      await context(),
      runner,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.argv).toEqual(expect.arrayContaining([
      "/usr/bin/docker", "compose", "--file", "compose.test.yaml",
      "run", "--build", "--rm", "--no-deps", "test",
      "ruff", "check", "--no-cache", ".",
    ]));
    expect(calls[1]!.argv.slice(-2)).toEqual(["down", "--remove-orphans"]);
    expect(calls[0]!.options).not.toHaveProperty("uid");
    expect(calls[0]!.options).not.toHaveProperty("gid");
    expect(calls[0]!.options.env).toEqual(calls[1]!.options.env);
    const stateDirectory = (calls[0]!.options.env as NodeJS.ProcessEnv).HOME!;
    await expect(stat(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(overridePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(execution.uid).toBe(process.getuid!());
    expect(execution.gid).toBe(process.getgid!());
  });

  it("executes db-check through the fixed read-only Compose override", async () => {
    const calls: string[][] = [];
    const runner: ApplyProfileRunner = async (argv) => {
      calls.push([...argv]);
      return result(argv);
    };
    await executeApplyProfile("s1-04b2-1-db-check@1", await context(), runner);
    expect(calls[0]!.slice(0, 8)).toEqual([
      "/usr/bin/docker",
      "compose",
      "--project-name",
      "example-managed-app-test",
      "--file",
      "compose.test.yaml",
      "--file",
      expect.stringMatching(/\/compose\.apply\.yaml$/),
    ]);
    expect(calls[0]!.slice(8)).toEqual(["run", "--build", "--rm", "test"]);
    expect(calls[0]).not.toContain("--no-deps");
    expect(calls[1]!.slice(0, 8)).toEqual(calls[0]!.slice(0, 8));
    expect(calls[1]!.slice(8)).toEqual(["down", "--remove-orphans"]);
  });

  it("rejects root or malformed fixed Docker identities", async () => {
    for (const [uid, gid] of [[0, 988], [996, 0], [Number.NaN, 988]]) {
      const input = await context();
      input.uid = uid;
      input.gid = gid;
      await expect(executeApplyProfile(
        "s1-04b2-1-db-check@1",
        input,
        async (argv) => result(argv),
      )).rejects.toThrow(/identity is invalid/);
    }
  });

  it("cleans up after spawn failure, timeout and signal", async () => {
    const spawnCalls: string[][] = [];
    let failedStateDirectory = "";
    const spawnRunner: ApplyProfileRunner = async (argv, options) => {
      spawnCalls.push([...argv]);
      failedStateDirectory = options.env?.HOME ?? "";
      if (spawnCalls.length === 1) {
        await writeFile(path.join(options.env!.DOCKER_CONFIG!, "spawn-check"), "ok");
        throw new Error("spawn failed");
      }
      return result(argv);
    };
    await expect(executeApplyProfile(
      "s1-04b2-1-db-check@1",
      await context(),
      spawnRunner,
    )).rejects.toThrow(/spawn failed/);
    expect(spawnCalls[1]!.slice(-2)).toEqual(["down", "--remove-orphans"]);
    await expect(stat(failedStateDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const timeoutCalls: string[][] = [];
    let timeoutStateDirectory = "";
    const timeoutRunner: ApplyProfileRunner = async (argv, options) => {
      timeoutCalls.push([...argv]);
      timeoutStateDirectory = options.env?.HOME ?? "";
      return timeoutCalls.length === 1
        ? result(argv, { code: null, signal: "SIGTERM", timedOut: true })
        : result(argv);
    };
    const execution = await executeApplyProfile(
      "s1-04b2-1-mypy@1",
      await context(),
      timeoutRunner,
    );
    expect(execution.result).toMatchObject({
      code: null,
      signal: "SIGTERM",
      timedOut: true,
    });
    expect(timeoutCalls[1]!.slice(-2)).toEqual(["down", "--remove-orphans"]);
    await expect(stat(timeoutStateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts exact ephemeral credentials before returning output", async () => {
    let call = 0;
    const runner: ApplyProfileRunner = async (argv, options) => {
      call += 1;
      if (call > 1) return result(argv);
      return result(argv, {
        code: 7,
        stdout: `password=${options.env?.PM_TEST_DB_PASSWORD}`,
        stderr: `auth=${options.env?.PM_TEST_AUTH_DIGEST_KEY}`,
      });
    };
    const execution = await executeApplyProfile(
      "s1-04b2-1-ruff-format@1",
      await context(),
      runner,
    );
    expect(execution.result.stdout).toBe("password=[REDACTED]");
    expect(execution.result.stderr).toBe("auth=[REDACTED]");
  });

  it("rejects cwd outside live and the direct staging root", async () => {
    const input = await context();
    input.cwd = os.tmpdir();
    await expect(executeApplyProfile(
      "s1-04b2-1-db-check@1",
      input,
      async (argv) => result(argv),
    )).rejects.toThrow(/cwd is not/);
  });
});
