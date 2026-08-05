import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrokerError } from "./errors.js";
import { runCommand, type RunOptions } from "./process.js";
import { sha256 } from "./security.js";
import {
  APPLY_PROFILE_IDS,
  type ApplyProfileId,
  type BrokerOptions,
  type CommandResult,
  type ProjectConfig,
} from "./types.js";

type ProfilePhase = "stage-setup" | "validation";
type ProfileMode = "configured-identity" | "make-db-check" | "docker-tool";

interface ProfileDefinition {
  phase: ProfilePhase;
  mode: ProfileMode;
  argv: string[];
  toolArgv?: string[];
}

const PROFILES: Record<ApplyProfileId, ProfileDefinition> = {
  "s1-04b1-frontend-npm-ci@1": {
    phase: "stage-setup",
    mode: "configured-identity",
    argv: [
      "/usr/bin/npm",
      "--prefix",
      "frontend",
      "ci",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
    ],
  },
  "s1-04b1-work-test@1": {
    phase: "validation",
    mode: "configured-identity",
    argv: [
      "/usr/bin/npm",
      "--prefix",
      "frontend",
      "test",
      "--",
      "--run",
      "tests/Work.test.tsx",
      "--configLoader",
      "runner",
    ],
  },
  "s1-04b1-typecheck@1": {
    phase: "validation",
    mode: "configured-identity",
    argv: ["/usr/bin/npm", "--prefix", "frontend", "run", "typecheck"],
  },
  "s1-04b1-lint@1": {
    phase: "validation",
    mode: "configured-identity",
    argv: ["/usr/bin/npm", "--prefix", "frontend", "run", "lint"],
  },
  "s1-04b2-1-db-check@1": {
    phase: "validation",
    mode: "make-db-check",
    argv: ["/usr/bin/make", "db-check"],
  },
  "s1-04b2-1-ruff-check@1": {
    phase: "validation",
    mode: "docker-tool",
    argv: ["/usr/bin/docker", "compose", "run", "test", "ruff", "check", "--no-cache", "."],
    toolArgv: ["ruff", "check", "--no-cache", "."],
  },
  "s1-04b2-1-ruff-format@1": {
    phase: "validation",
    mode: "docker-tool",
    argv: ["/usr/bin/docker", "compose", "run", "test", "ruff", "format", "--check", "."],
    toolArgv: ["ruff", "format", "--no-cache", "--check", "."],
  },
  "s1-04b2-1-mypy@1": {
    phase: "validation",
    mode: "docker-tool",
    argv: ["/usr/bin/docker", "compose", "run", "test", "mypy", "app", "tests"],
    toolArgv: ["mypy", "--cache-dir=/tmp/mypy-cache", "app", "tests"],
  },
};

export type ApplyProfileRunner = (
  argv: readonly string[],
  options: RunOptions,
) => Promise<CommandResult>;

export interface ApplyProfileExecutionContext {
  options: BrokerOptions;
  project: ProjectConfig;
  cwd: string;
  uid: number;
  gid: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ApplyProfileExecution {
  result: CommandResult;
  uid: number;
  gid: number;
}

let dockerTail: Promise<void> = Promise.resolve();

function serializeDocker<T>(operation: () => Promise<T>): Promise<T> {
  const result = dockerTail.then(operation, operation);
  dockerTail = result.then(() => undefined, () => undefined);
  return result;
}

export function isApplyProfileId(value: unknown): value is ApplyProfileId {
  return typeof value === "string" && (APPLY_PROFILE_IDS as readonly string[]).includes(value);
}

export function expandApplyProfiles(
  profileIds: readonly ApplyProfileId[],
  phase: ProfilePhase,
): string[][] {
  return profileIds.map((profileId) => {
    const profile = PROFILES[profileId];
    if (profile.phase !== phase) {
      throw new BrokerError(
        "INVALID_REGISTRY",
        `${profileId} cannot be used as a ${phase} profile`,
      );
    }
    return [...profile.argv];
  });
}

async function assertFixedCwd(context: ApplyProfileExecutionContext): Promise<void> {
  const actual = await realpath(context.cwd);
  const live = await realpath(context.project.realPath);
  if (actual === live) return;
  const staging = await realpath(path.join(context.options.dataDir, "staging"));
  const relative = path.relative(staging, actual);
  if (
    relative === ""
    || relative.startsWith("..")
    || path.isAbsolute(relative)
    || relative.includes(path.sep)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(relative)
  ) {
    throw new BrokerError(
      "APPLY_PROFILE_CWD_INVALID",
      "fixed validation profile cwd is not the live project or a direct isolated stage",
      409,
    );
  }
}

function redactExact(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets) {
    if (secret) output = output.replaceAll(secret, "[REDACTED]");
  }
  return output;
}

function sanitizeResult(result: CommandResult, secrets: readonly string[]): CommandResult {
  return {
    ...result,
    stdout: redactExact(result.stdout, secrets),
    stderr: redactExact(result.stderr, secrets),
  };
}

function cleanupFailed(result: CommandResult | undefined): boolean {
  return result === undefined
    || result.code !== 0
    || result.signal !== null
    || result.timedOut
    || result.truncated;
}

function combineCleanupFailure(
  primary: CommandResult,
  cleanup: CommandResult | undefined,
): CommandResult {
  if (!cleanupFailed(cleanup)) return primary;
  const cleanupMessage = cleanup
    ? `fixed Docker cleanup failed: code=${cleanup.code ?? "null"} signal=${cleanup.signal ?? "none"}`
    : "fixed Docker cleanup could not be started";
  if (
    primary.code !== 0
    || primary.signal !== null
    || primary.timedOut
    || primary.truncated
  ) {
    return {
      ...primary,
      stderr: `${primary.stderr}\n${cleanupMessage}`.trim(),
    };
  }
  return {
    ...primary,
    code: cleanup?.code ?? 1,
    signal: cleanup?.signal ?? null,
    timedOut: cleanup?.timedOut ?? false,
    truncated: primary.truncated || (cleanup?.truncated ?? false),
    stderr: `${primary.stderr}\n${cleanupMessage}`.trim(),
  };
}

function inheritedIdentity(): { uid: number; gid: number } {
  if (!process.getuid || !process.getgid) {
    throw new BrokerError("APPLY_PROFILE_FAILED", "POSIX process identity is unavailable", 500);
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

function fixedComposeOverride(uid: number, gid: number): string {
  if (
    !Number.isSafeInteger(uid)
    || !Number.isSafeInteger(gid)
    || uid <= 0
    || gid <= 0
  ) {
    throw new BrokerError(
      "APPLY_PROFILE_FAILED",
      "fixed Docker validation identity is invalid",
      500,
    );
  }
  return [
    "services:",
    "  test:",
    `    user: "${uid}:${gid}"`,
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
  ].join("\n");
}

async function executeDockerProfile(
  profileId: ApplyProfileId,
  context: ApplyProfileExecutionContext,
  runner: ApplyProfileRunner,
): Promise<ApplyProfileExecution> {
  const profile = PROFILES[profileId];
  const password = randomBytes(32).toString("base64url");
  const authKey = randomBytes(48).toString("base64url");
  const secrets = [password, authKey];
  const composeProject = profile.mode === "make-db-check"
    ? "example-managed-app-test"
    : `project-ops-${sha256(context.cwd).slice(0, 16)}`;
  const stateRoot = path.join(context.options.dataDir, "tmp", "apply-docker");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  const stateDirectory = await mkdtemp(path.join(stateRoot, "run-"));

  try {
    await chmod(stateDirectory, 0o700);
    const dockerConfig = path.join(stateDirectory, "docker");
    const temporaryDirectory = path.join(stateDirectory, "tmp");
    const composeOverride = path.join(stateDirectory, "compose.apply.yaml");
    await mkdir(dockerConfig, { mode: 0o700 });
    await mkdir(temporaryDirectory, { mode: 0o700 });
    await writeFile(
      composeOverride,
      fixedComposeOverride(context.uid, context.gid),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const composePrefix = [
      "/usr/bin/docker",
      "compose",
      "--project-name",
      composeProject,
      "--file",
      "compose.test.yaml",
      "--file",
      composeOverride,
    ];
    const mainArgv = profile.mode === "make-db-check"
      ? [...composePrefix, "run", "--build", "--rm", "test"]
      : [
          ...composePrefix,
          "run",
          "--build",
          "--rm",
          "--no-deps",
          "test",
          ...profile.toolArgv!,
        ];
    const cleanupArgv = [...composePrefix, "down", "--remove-orphans"];
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      HOME: stateDirectory,
      DOCKER_CONFIG: dockerConfig,
      TMPDIR: temporaryDirectory,
      PM_TEST_DB_PASSWORD: password,
      PM_TEST_AUTH_DIGEST_KEY: authKey,
    };
    return await serializeDocker(async () => {
      let primary: CommandResult | undefined;
      let primaryError: unknown;
      let cleanup: CommandResult | undefined;
      try {
        primary = await runner(mainArgv, {
          cwd: context.cwd,
          env,
          timeoutMs: context.timeoutMs,
          maxOutputBytes: context.maxOutputBytes,
        });
      } catch (error) {
        primaryError = error;
      } finally {
        cleanup = await runner(cleanupArgv, {
          cwd: context.cwd,
          env,
          timeoutMs: 120_000,
          maxOutputBytes: context.maxOutputBytes,
        }).catch(() => undefined);
      }
      if (primaryError) {
        const message = primaryError instanceof Error
          ? redactExact(primaryError.message, secrets)
          : "fixed validation profile could not be started";
        throw new BrokerError("APPLY_PROFILE_FAILED", message, 409);
      }
      if (!primary) {
        throw new BrokerError("APPLY_PROFILE_FAILED", "fixed validation profile returned no result", 409);
      }
      return {
        result: combineCleanupFailure(
          sanitizeResult(primary, secrets),
          cleanup ? sanitizeResult(cleanup, secrets) : undefined,
        ),
        ...inheritedIdentity(),
      };
    });
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

export async function executeApplyProfile(
  profileId: ApplyProfileId,
  context: ApplyProfileExecutionContext,
  runner: ApplyProfileRunner = runCommand,
): Promise<ApplyProfileExecution> {
  await assertFixedCwd(context);
  const profile = PROFILES[profileId];
  if (profile.mode === "configured-identity") {
    let argv = profile.argv;
    if (argv[0] === "/usr/bin/npm") {
      const systemNpm = await access(argv[0], constants.X_OK).then(() => true, () => false);
      if (!systemNpm) {
        const targetLocalNpm = path.join(path.dirname(process.execPath), "npm");
        const localAvailable = await access(targetLocalNpm, constants.X_OK).then(() => true, () => false);
        if (!localAvailable) {
          throw new BrokerError("APPLY_PROFILE_FAILED", "fixed npm executable is unavailable", 409);
        }
        argv = [targetLocalNpm, ...argv.slice(1)];
      }
    }
    return {
      result: await runner(argv, {
        cwd: context.cwd,
        uid: context.uid,
        gid: context.gid,
        timeoutMs: context.timeoutMs,
        maxOutputBytes: context.maxOutputBytes,
        env: {
          PATH: `${path.dirname(process.execPath)}:/usr/sbin:/usr/bin:/sbin:/bin`,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
        },
      }),
      uid: context.uid,
      gid: context.gid,
    };
  }
  return await executeDockerProfile(profileId, context, runner);
}
