import { randomUUID } from "node:crypto";
import { cp, lchown, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  availableApplyRecipes,
  legacyValidationRecipeHash,
  resolveBindingRecipe,
  selectApplyRecipe,
  samePathSet,
  withApplyRecipe,
} from "./apply-recipes.js";
import { BrokerError } from "./errors.js";
import { fingerprintDirectory, fingerprintProject } from "./fingerprint.js";
import { runCommand } from "./process.js";
import { assertSafeIdentifier, isExcludedRelativePath, redactDiagnosticText, sha256 } from "./security.js";
import { executeApplyProfile } from "./validation-profiles.js";
import type {
  ApplyBindingRecipeReference,
  ApplyProfileId,
  ApprovalRecord,
  BrokerOptions,
  CommandResult,
  ProjectConfig,
} from "./types.js";

export interface StageManifest {
  schemaVersion: 1;
  id: string;
  projectId: string;
  sourceHash: string;
  requestHash: string;
  createdAt: string;
  mode: "isolated-git" | "git-worktree" | "snapshot";
  path: string;
  codex: { attempted: boolean; ok: boolean; exitCode?: number | null; summary?: string };
}

export type SandboxStage =
  | "process-spawn"
  | "authentication"
  | "sandbox-startup"
  | "source-validation"
  | "apply-validation"
  | "stage-creation"
  | "task-execution"
  | "execution-timeout"
  | "broker-recovery"
  | "result-persistence";

export interface CodexFailureDetails {
  sandboxStage: SandboxStage;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export type ApplyValidationPhase =
  | "stage-pre-apply"
  | "live-pre-apply"
  | "live-post-apply"
  | "failed-apply-rollback"
  | "rollback-pre-check"
  | "rollback-post-check";

export interface ValidationCommandDiagnostic {
  commandIndex: number;
  commandId: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timeout: boolean;
  outputTruncated: boolean;
  stdout: string;
  stderr: string;
  cwd: string;
  uid: number;
  gid: number;
  resultHash: string;
}

export class ApplyValidationError extends BrokerError {
  readonly stageId: string;
  readonly developApprovalId: string;
  readonly candidateCommit: string;
  readonly validationPhase: ApplyValidationPhase;
  readonly validationResults: ValidationCommandDiagnostic[];

  constructor(input: {
    stageId: string;
    developApprovalId: string;
    candidateCommit: string;
    validationPhase: ApplyValidationPhase;
    validationResults: ValidationCommandDiagnostic[];
    reason: string;
    rolledBack?: boolean;
  }) {
    const failed = input.validationResults.at(-1);
    const suffix = input.rolledBack ? "; live commit was reverted" : "";
    super(
      "APPLY_VALIDATION_FAILED",
      `${input.validationPhase} validation command ${failed?.commandIndex ?? "unknown"} failed: ${input.reason}${suffix}`,
      409,
    );
    this.name = "ApplyValidationError";
    this.stageId = assertSafeIdentifier(input.stageId, "stageId");
    this.developApprovalId = assertSafeIdentifier(input.developApprovalId, "developApprovalId");
    this.candidateCommit = input.candidateCommit;
    this.validationPhase = input.validationPhase;
    this.validationResults = input.validationResults;
  }

  afterRollback(): ApplyValidationError {
    return new ApplyValidationError({
      stageId: this.stageId,
      developApprovalId: this.developApprovalId,
      candidateCommit: this.candidateCommit,
      validationPhase: this.validationPhase,
      validationResults: this.validationResults,
      reason: validationFailureReason(this.validationResults.at(-1)),
      rolledBack: true,
    });
  }
}

class DiagnosticPersistenceError extends BrokerError {
  constructor() {
    super(
      "DIAGNOSTIC_PERSISTENCE_FAILED",
      "Codex failure diagnostic could not be persisted; stage was preserved",
      500,
    );
    this.name = "DiagnosticPersistenceError";
  }
}

export class StageExecutionError extends BrokerError {
  readonly stageId: string;

  constructor(stageId: string, cause: unknown) {
    const normalized = cause instanceof BrokerError
      ? cause
      : new BrokerError(
        "STAGE_EXECUTION_FAILED",
        cause instanceof Error ? cause.message : "unknown stage execution failure",
        500,
      );
    super(normalized.code, normalized.message, normalized.statusCode);
    this.name = "StageExecutionError";
    this.stageId = assertSafeIdentifier(stageId, "stageId");
  }
}

export function stageIdFromError(error: unknown): string | undefined {
  if (error instanceof StageExecutionError || error instanceof ApplyValidationError) return error.stageId;
  return undefined;
}

function stagesRoot(options: BrokerOptions): string {
  return path.join(options.dataDir, "staging");
}

function git(directory: string, ...args: string[]): string[] {
  return ["/usr/bin/git", "-c", `safe.directory=${directory}`, "-C", directory, ...args];
}

function manifestPath(options: BrokerOptions, stageId: string): string {
  return path.join(stagesRoot(options), `${assertSafeIdentifier(stageId, "stageId")}.json`);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640, flag: "wx" });
  await rename(temporary, filePath);
}

export async function persistStageFailure(
  options: BrokerOptions,
  manifest: StageManifest,
  approvalId: string,
  request: string,
  details: CodexFailureDetails,
): Promise<void> {
  const resultDir = path.join(options.dataDir, "tasks");
  const diagnosticPath = path.join(resultDir, `${manifest.id}.failure.json`);
  if (await stat(diagnosticPath).then((value) => value.isFile()).catch(() => false)) return;
  const stageInfo = await stat(manifest.path).catch(() => null);
  const payload = {
    schemaVersion: 1,
    approvalId: assertSafeIdentifier(approvalId, "approvalId"),
    stageId: manifest.id,
    createdAt: new Date().toISOString(),
    sandboxStage: details.sandboxStage,
    exitCode: details.exitCode,
    signal: details.signal,
    stdout: redactDiagnosticText(details.stdout, request),
    stderr: redactDiagnosticText(details.stderr, request),
    outputTruncated: details.outputTruncated,
    stageExistedAtCapture: stageInfo?.isDirectory() === true,
  };
  const diagnostic = { ...payload, resultHash: sha256(JSON.stringify(payload)) };
  try {
    await mkdir(resultDir, { recursive: true, mode: 0o750 });
    await writeJsonAtomic(diagnosticPath, diagnostic);
  } catch {
    throw new DiagnosticPersistenceError();
  }
}

export async function persistApplyValidationFailure(
  options: BrokerOptions,
  approvalId: string,
  request: string,
  error: ApplyValidationError,
): Promise<void> {
  const resultDir = path.join(options.dataDir, "tasks");
  const id = assertSafeIdentifier(approvalId, "approvalId");
  const diagnosticPath = path.join(resultDir, `${id}.failure.json`);
  if (await stat(diagnosticPath).then((value) => value.isFile()).catch(() => false)) return;
  const validationResults = error.validationResults.map((entry) => {
    const { resultHash: _oldHash, ...raw } = entry;
    const commandPayload = {
      ...raw,
      stdout: redactDiagnosticText(raw.stdout, request),
      stderr: redactDiagnosticText(raw.stderr, request),
    };
    return { ...commandPayload, resultHash: sha256(JSON.stringify(commandPayload)) };
  });
  const failed = validationResults.at(-1);
  const payload = {
    schemaVersion: 2,
    approvalId: id,
    stageId: error.stageId,
    state: "failed",
    createdAt: new Date().toISOString(),
    sandboxStage: "apply-validation",
    developApprovalId: error.developApprovalId,
    candidateCommit: error.candidateCommit,
    validationPhase: error.validationPhase,
    exitCode: failed?.exitCode ?? null,
    signal: failed?.signal ?? null,
    timeout: failed?.timeout ?? false,
    stdout: failed?.stdout ?? "",
    stderr: failed?.stderr ?? "",
    outputTruncated: failed?.outputTruncated ?? false,
    validationResults,
  };
  const diagnostic = { ...payload, resultHash: sha256(JSON.stringify(payload)) };
  try {
    await mkdir(resultDir, { recursive: true, mode: 0o750 });
    await writeJsonAtomic(diagnosticPath, diagnostic);
  } catch {
    throw new DiagnosticPersistenceError();
  }
}

async function chownTree(root: string, uid: number, gid: number): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await chownTree(target, uid, gid);
    await lchown(target, uid, gid);
  }
  await lchown(root, uid, gid);
}

export async function loadStage(options: BrokerOptions, stageId: string): Promise<StageManifest> {
  const parsed = JSON.parse(await readFile(manifestPath(options, stageId), "utf8")) as StageManifest;
  if (parsed.schemaVersion !== 1 || parsed.id !== stageId) throw new BrokerError("INVALID_STAGE", "stage manifest is invalid");
  const root = await path.resolve(stagesRoot(options));
  const target = path.resolve(parsed.path);
  if (target !== path.join(root, stageId)) throw new BrokerError("INVALID_STAGE", "stage path escaped its root");
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) throw new BrokerError("STAGE_NOT_FOUND", "stage directory is missing", 404);
  return parsed;
}

async function invokeCodex(
  options: BrokerOptions,
  manifest: StageManifest,
  approvalId: string,
  request: string,
  timeoutMs: number,
): Promise<void> {
  if (
    !options.codexExecutable ||
    !options.codexRunner ||
    !options.codexHome ||
    !options.codexAgentDir ||
    !options.codexConfigPath ||
    options.serviceUid === undefined ||
    options.serviceGid === undefined
  ) {
    manifest.codex = { attempted: false, ok: false, summary: "Codex subprocess is not configured" };
    await persistStageFailure(options, manifest, approvalId, request, {
      sandboxStage: "sandbox-startup",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "Codex subprocess is not configured",
      outputTruncated: false,
    });
    throw new BrokerError("CODEX_NOT_CONFIGURED", "Codex subprocess is not configured", 500);
  }
  const resultDir = path.join(options.dataDir, "tasks");
  try {
    await mkdir(resultDir, { recursive: true, mode: 0o750 });
  } catch {
    throw new DiagnosticPersistenceError();
  }
  let result: CommandResult;
  try {
    result = await runCommand([
      process.execPath,
      options.codexRunner,
      "--codex", options.codexExecutable,
      "--codex-home", options.codexHome,
      "--agent-dir", options.codexAgentDir,
      "--cwd", manifest.path,
    ], {
      cwd: manifest.path,
      timeoutMs,
      maxOutputBytes: 512 * 1024,
      uid: options.serviceUid,
      gid: options.serviceGid,
      input: request,
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/sbin:/usr/bin:/sbin:/bin`,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        HOME: options.codexHome,
        CODEX_HOME: options.codexHome,
        OPENCLAW_STATE_DIR: path.join(options.dataDir, "state"),
        OPENCLAW_CONFIG_PATH: options.codexConfigPath,
        TMPDIR: path.join(options.dataDir, "tmp"),
      },
    });
  } catch (error) {
    await persistStageFailure(options, manifest, approvalId, request, {
      sandboxStage: "process-spawn",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : "unknown spawn failure",
      outputTruncated: false,
    });
    throw error;
  }
  let runnerOutput: { summary?: unknown } | undefined;
  if (result.code === 0) {
    try {
      runnerOutput = JSON.parse(result.stdout) as { summary?: unknown };
    } catch {
      result = {
        ...result,
        code: 1,
        stderr: "managed Codex runner returned invalid output",
      };
    }
  }
  const summary = typeof runnerOutput?.summary === "string"
    ? runnerOutput.summary
    : (result.stderr || result.stdout);
  manifest.codex = {
    attempted: true,
    ok: result.code === 0 && !result.timedOut,
    exitCode: result.code,
    summary: redactDiagnosticText(summary, request, 500).replace(/\s+/g, " ").trim(),
  };
  if (!manifest.codex.ok) {
    await persistStageFailure(options, manifest, approvalId, request, {
      sandboxStage: result.timedOut
        ? "execution-timeout"
        : result.code === 78 ? "authentication" : "task-execution",
      exitCode: result.code,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      outputTruncated: result.truncated,
    });
    throw new BrokerError("DEVELOPMENT_FAILED", "Codex staging task failed; live project was not changed", 409);
  }
}

async function cleanupFailedStage(project: ProjectConfig, manifest: StageManifest): Promise<void> {
  if (manifest.mode !== "git-worktree") {
    await rm(manifest.path, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  const removed = await runCommand(git(project.realPath, "worktree", "remove", "--force", manifest.path), {
    timeoutMs: 120_000,
    maxOutputBytes: 128 * 1024,
  }).catch(() => null);
  if (!removed || removed.code !== 0) {
    await rm(manifest.path, { recursive: true, force: true }).catch(() => undefined);
  }
  await runCommand(git(project.realPath, "worktree", "prune", "--expire", "now"), {
    timeoutMs: 120_000,
    maxOutputBytes: 128 * 1024,
  }).catch(() => undefined);
}

export async function discardStageForRecovery(
  options: BrokerOptions,
  project: ProjectConfig,
  stageId: string,
): Promise<void> {
  const id = assertSafeIdentifier(stageId, "stageId");
  const target = path.join(stagesRoot(options), id);
  const manifest = await readFile(manifestPath(options, id), "utf8")
    .then((value) => JSON.parse(value) as StageManifest)
    .catch(() => null);
  if (manifest) {
    if (manifest.id !== id || path.resolve(manifest.path) !== path.resolve(target)) {
      throw new BrokerError("INVALID_STAGE", "recovery stage manifest is invalid", 409);
    }
    await cleanupFailedStage(project, manifest);
  } else {
    await rm(target, { recursive: true, force: true });
  }
  await rm(manifestPath(options, id), { force: true });
  await rm(`${target}.bundle`, { force: true });
}

export async function createStage(
  options: BrokerOptions,
  project: ProjectConfig,
  approvalId: string,
  sourceHash: string,
  request: string,
  stageId: string = randomUUID(),
  timeoutMs = 45 * 60_000,
): Promise<StageManifest> {
  const id = assertSafeIdentifier(stageId, "stageId");
  const root = stagesRoot(options);
  const target = path.join(root, id);
  await mkdir(root, { recursive: true, mode: 0o750 });
  const manifest: StageManifest = {
    schemaVersion: 1,
    id,
    projectId: project.id,
    sourceHash,
    requestHash: sha256(request),
    createdAt: new Date().toISOString(),
    mode: project.sourceMode === "clean-git" ? "isolated-git" : "snapshot",
    path: target,
    codex: { attempted: false, ok: false },
  };
  try {
    if (manifest.mode === "isolated-git") {
      const bundlePath = `${target}.bundle`;
      try {
        const bundled = await runCommand(
          git(project.realPath, "bundle", "create", bundlePath, "HEAD"),
          { timeoutMs: 120_000, maxOutputBytes: 128 * 1024 },
        );
        if (bundled.code !== 0) {
          throw new BrokerError("STAGE_FAILED", `isolated Git bundle failed: ${bundled.stderr.slice(0, 500)}`);
        }
        const cloned = await runCommand([
          "/usr/bin/git",
          "clone",
          "--no-tags",
          "--no-recurse-submodules",
          bundlePath,
          target,
        ], {
          timeoutMs: 120_000,
          maxOutputBytes: 128 * 1024,
        });
        if (cloned.code !== 0) {
          throw new BrokerError("STAGE_FAILED", `isolated Git clone failed: ${cloned.stderr.slice(0, 500)}`);
        }
      } finally {
        await rm(bundlePath, { force: true }).catch(() => undefined);
      }
    } else {
      await cp(project.realPath, target, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        filter: (source) => {
          const relative = path.relative(project.realPath, source);
          return relative === "" || !isExcludedRelativePath(relative);
        },
      });
    }
    if (options.serviceUid !== undefined && options.serviceGid !== undefined) {
      await chownTree(target, options.serviceUid, options.serviceGid);
    }
    await invokeCodex(options, manifest, approvalId, request, timeoutMs);
    await writeJsonAtomic(manifestPath(options, id), manifest);
    return manifest;
  } catch (error) {
    if (error instanceof DiagnosticPersistenceError) throw new StageExecutionError(id, error);
    try {
      await persistStageFailure(options, manifest, approvalId, request, {
        sandboxStage: "stage-creation",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : "unknown stage creation failure",
        outputTruncated: false,
      });
    } catch (diagnosticError) {
      throw new StageExecutionError(id, diagnosticError);
    }
    await cleanupFailedStage(project, manifest);
    throw new StageExecutionError(id, error);
  }
}

type ApplyBindingState = "ready" | "applying" | "applied" | "rolled-back";

interface ApplyBinding extends ApplyBindingRecipeReference {
  schemaVersion: 1 | 2 | 3;
  projectId: string;
  stageId: string;
  developApprovalId: string;
  applyApprovalId: string;
  previousApplyApprovalId?: string;
  developResultHash: string;
  sourceHash: string;
  baseCommit: string;
  candidateCommit: string;
  candidateTree: string;
  commitDiffHash: string;
  allowedPaths: string[];
  rollbackId: string;
  state: ApplyBindingState;
  rebindCount?: number;
  createdAt: string;
  reboundAt?: string;
  liveCommit?: string;
  appliedAt?: string;
  rollbackCommit?: string;
  bindingHash: string;
}

interface RollbackManifest {
  schemaVersion: 2;
  id: string;
  projectId: string;
  stageId: string;
  applyApprovalId: string;
  liveCommit: string;
  state: "ready" | "rolled-back";
  createdAt: string;
  rollbackCommit?: string;
  rolledBackAt?: string;
  manifestHash: string;
}

function applyBindingPath(options: BrokerOptions, stageId: string): string {
  return path.join(stagesRoot(options), `${assertSafeIdentifier(stageId, "stageId")}.apply.json`);
}

function rebindClaimPath(options: BrokerOptions, binding: ApplyBinding): string {
  if (!/^[a-f0-9]{64}$/.test(binding.bindingHash)) {
    throw new BrokerError("STAGE_BINDING_CORRUPT", "stage binding hash is invalid", 409);
  }
  return path.join(
    stagesRoot(options),
    `${assertSafeIdentifier(binding.stageId, "stageId")}.rebind.${binding.bindingHash}.claim`,
  );
}

function rollbackManifestPath(options: BrokerOptions, projectId: string, snapshotId: string): string {
  return path.join(
    options.dataDir,
    "rollback",
    assertSafeIdentifier(projectId, "projectId"),
    `${assertSafeIdentifier(snapshotId, "snapshotId")}.json`,
  );
}

function withIntegrity<T extends Record<string, unknown>>(payload: T, field: "bindingHash" | "manifestHash"): T & Record<typeof field, string> {
  const normalized = { ...payload };
  delete normalized[field];
  return { ...normalized, [field]: sha256(JSON.stringify(normalized)) } as T & Record<typeof field, string>;
}

async function readApplyBinding(options: BrokerOptions, stageId: string): Promise<ApplyBinding> {
  const parsed = JSON.parse(await readFile(applyBindingPath(options, stageId), "utf8")) as ApplyBinding;
  const { bindingHash, ...payload } = parsed;
  const schema2Valid = parsed.schemaVersion !== 2
    || /^[a-f0-9]{64}$/.test(parsed.validationRecipeHash ?? "");
  const schema3Valid = parsed.schemaVersion !== 3
    || (
      typeof parsed.recipeId === "string"
      && /^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed.recipeId)
      && Number.isSafeInteger(parsed.recipeVersion)
      && (parsed.recipeVersion ?? 0) >= 1
      && /^[a-f0-9]{64}$/.test(parsed.recipeConfigHash ?? "")
    );
  if (
    ![1, 2, 3].includes(parsed.schemaVersion)
    || parsed.stageId !== stageId
    || !schema2Valid
    || !schema3Valid
    || typeof bindingHash !== "string"
    || bindingHash !== sha256(JSON.stringify(payload))
  ) {
    throw new BrokerError("STAGE_BINDING_CORRUPT", "stage apply binding failed integrity validation", 409);
  }
  return parsed;
}

async function writeApplyBinding(options: BrokerOptions, binding: Omit<ApplyBinding, "bindingHash">): Promise<ApplyBinding> {
  const value = withIntegrity(binding as unknown as Record<string, unknown>, "bindingHash") as unknown as ApplyBinding;
  await writeJsonAtomic(applyBindingPath(options, binding.stageId), value);
  return value;
}

async function readApproval(options: BrokerOptions, approvalId: string): Promise<ApprovalRecord> {
  const id = assertSafeIdentifier(approvalId, "approvalId");
  const value = JSON.parse(await readFile(path.join(options.dataDir, "approvals", `${id}.json`), "utf8")) as ApprovalRecord;
  if (value.schemaVersion !== 1 || value.id !== id) throw new BrokerError("INVALID_APPROVAL", "approval record is invalid");
  return value;
}

async function findExecutedDevelopApproval(
  options: BrokerOptions,
  project: ProjectConfig,
  stage: StageManifest,
): Promise<{ record: ApprovalRecord; resultHash: string }> {
  const files = await readdir(path.join(options.dataDir, "approvals"));
  const matches: ApprovalRecord[] = [];
  for (const file of files) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\.json$/.test(file)) continue;
    const record = await readApproval(options, file.slice(0, -5)).catch(() => null);
    const result = record?.result as Partial<StageManifest> | undefined;
    if (
      record?.state === "executed"
      && record.kind === "develop"
      && record.projectId === project.id
      && result?.id === stage.id
    ) {
      matches.push(record);
    }
  }
  if (matches.length !== 1) {
    throw new BrokerError("STAGE_APPROVAL_BINDING_INVALID", "stage is not uniquely bound to one executed develop approval", 409);
  }
  const record = matches[0]!;
  const result = record.result as StageManifest;
  const resultHash = sha256(JSON.stringify(result));
  if (
    result.projectId !== project.id
    || result.sourceHash !== record.sourceHash
    || result.requestHash !== record.requestHash
    || result.path !== stage.path
    || result.mode !== "isolated-git"
    || result.codex?.ok !== true
    || result.codex?.exitCode !== 0
    || resultHash !== sha256(JSON.stringify(stage))
    || stage.sourceHash !== record.sourceHash
    || stage.requestHash !== record.requestHash
  ) {
    throw new BrokerError("STAGE_RESULT_TAMPERED", "stage manifest no longer matches its executed develop result", 409);
  }
  return { record, resultHash };
}

async function checkedGit(
  directory: string,
  args: string[],
  options: { uid?: number; gid?: number; maxOutputBytes?: number; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const result = await runCommand(git(directory, ...args), {
    ...(options.uid === undefined ? {} : { uid: options.uid }),
    ...(options.gid === undefined ? {} : { gid: options.gid }),
    maxOutputBytes: options.maxOutputBytes ?? 512 * 1024,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  if (result.code !== 0 || result.timedOut || result.truncated) {
    throw new BrokerError("GIT_VALIDATION_FAILED", `fixed Git operation failed: ${redactDiagnosticText(result.stderr, "", 500)}`, 409);
  }
  return result;
}

function lines(value: string): string[] {
  return value.split("\n").map((entry) => entry.trim()).filter(Boolean).sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function applyRecipeHash(project: ProjectConfig): string {
  if (!project.applyRecipe) throw new BrokerError("APPLY_RECIPE_MISSING", "fixed apply recipe is missing", 403);
  return legacyValidationRecipeHash(project.applyRecipe);
}

function projectForBinding(
  project: ProjectConfig,
  binding: ApplyBinding,
  allowSchema1: boolean,
): ProjectConfig {
  return withApplyRecipe(
    project,
    resolveBindingRecipe(availableApplyRecipes(project), binding, allowSchema1),
  );
}

function validationFailureReason(result: ValidationCommandDiagnostic | undefined): string {
  if (!result) return "command result unavailable";
  if (result.timeout) return "timeout";
  if (result.signal) return `signal ${result.signal}`;
  if (result.exitCode !== 0) return `exit code ${result.exitCode ?? "null"}`;
  if (result.outputTruncated) return "output exceeded the fixed capture limit";
  return "command failed";
}

async function assertCleanGit(directory: string, uid?: number, gid?: number): Promise<void> {
  const status = await checkedGit(directory, ["status", "--porcelain=v1", "--untracked-files=all"], {
    ...(uid === undefined ? {} : { uid }),
    ...(gid === undefined ? {} : { gid }),
  });
  if (status.stdout !== "") throw new BrokerError("WORKTREE_NOT_CLEAN", "Git worktree is not clean", 409);
}

async function runApplyVerification(
  options: BrokerOptions,
  project: ProjectConfig,
  cwd: string,
  uid: number,
  gid: number,
  phase: ApplyValidationPhase,
  cwdLabel: string,
  binding: ApplyBinding,
): Promise<ValidationCommandDiagnostic[]> {
  if (!project.applyRecipe) throw new BrokerError("APPLY_RECIPE_MISSING", "fixed apply recipe is missing", 403);
  const diagnostics: ValidationCommandDiagnostic[] = [];
  for (const [index, argv] of project.applyRecipe.verify.entries()) {
    const profileId = project.applyRecipe.validationProfiles?.[index] as ApplyProfileId | undefined;
    const startedAt = new Date().toISOString();
    let result: CommandResult;
    let executionUid = uid;
    let executionGid = gid;
    try {
      if (profileId) {
        const execution = await executeApplyProfile(profileId, {
          options,
          project,
          cwd,
          uid,
          gid,
          timeoutMs: options.applyValidationTimeoutMs ?? 20 * 60_000,
          maxOutputBytes: options.applyValidationMaxOutputBytes ?? 32 * 1024,
        });
        result = execution.result;
        executionUid = execution.uid;
        executionGid = execution.gid;
      } else {
        result = await runCommand(argv, {
          cwd,
          uid,
          gid,
          timeoutMs: options.applyValidationTimeoutMs ?? 20 * 60_000,
          maxOutputBytes: options.applyValidationMaxOutputBytes ?? 32 * 1024,
        });
      }
    } catch (error) {
      result = {
        argv: [...argv],
        code: null,
        signal: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : "validation command could not be started",
        timedOut: false,
        truncated: false,
        durationMs: 0,
      };
    }
    const stdout = redactDiagnosticText(result.stdout, "", 8_192);
    const stderr = redactDiagnosticText(result.stderr, "", 8_192);
    const commandPayload = {
      commandIndex: index + 1,
      commandId: sha256(JSON.stringify(argv)),
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.code,
      signal: result.signal,
      timeout: result.timedOut,
      outputTruncated: result.truncated || stdout.endsWith("[TRUNCATED]") || stderr.endsWith("[TRUNCATED]"),
      stdout,
      stderr,
      cwd: cwdLabel,
      uid: executionUid,
      gid: executionGid,
    };
    const diagnostic = {
      ...commandPayload,
      resultHash: sha256(JSON.stringify(commandPayload)),
    };
    diagnostics.push(diagnostic);
    if (result.code !== 0 || result.timedOut || diagnostic.outputTruncated) {
      throw new ApplyValidationError({
        stageId: binding.stageId,
        developApprovalId: binding.developApprovalId,
        candidateCommit: binding.candidateCommit,
        validationPhase: phase,
        validationResults: diagnostics,
        reason: validationFailureReason(diagnostic),
      });
    }
  }
  return diagnostics;
}

async function runStageSetup(options: BrokerOptions, project: ProjectConfig, stage: StageManifest): Promise<void> {
  if (!project.applyRecipe || options.serviceUid === undefined || options.serviceGid === undefined) return;
  for (const [index, argv] of project.applyRecipe.stageSetup.entries()) {
    const profileId = project.applyRecipe.stageSetupProfiles?.[index] as ApplyProfileId | undefined;
    const result = profileId
      ? (await executeApplyProfile(profileId, {
          options,
          project,
          cwd: stage.path,
          uid: options.serviceUid,
          gid: options.serviceGid,
          timeoutMs: 20 * 60_000,
          maxOutputBytes: 512 * 1024,
        })).result
      : await runCommand(argv, {
          cwd: stage.path,
          uid: options.serviceUid,
          gid: options.serviceGid,
          timeoutMs: 20 * 60_000,
          maxOutputBytes: 512 * 1024,
        });
    if (result.code !== 0 || result.timedOut || result.truncated) {
      throw new BrokerError("APPLY_STAGE_SETUP_FAILED", "fixed offline stage setup failed", 409);
    }
  }
}

async function validateFrozenCandidate(
  options: BrokerOptions,
  project: ProjectConfig,
  stage: StageManifest,
  binding: ApplyBinding,
  requireRecipeHash: boolean,
): Promise<void> {
  const recipe = project.applyRecipe;
  const recipeBindingMatches = recipe !== undefined && (
    binding.schemaVersion === 1
      ? !requireRecipeHash
      : binding.schemaVersion === 2
        ? binding.validationRecipeHash === legacyValidationRecipeHash(recipe)
        : (
            binding.recipeId === recipe.id
            && binding.recipeVersion === recipe.version
            && binding.recipeConfigHash === recipe.configHash
          )
  );
  if (
    binding.projectId !== project.id
    || binding.stageId !== stage.id
    || binding.sourceHash !== stage.sourceHash
    || !recipe
    || !samePathSet(binding.allowedPaths, recipe.allowedPaths)
    || !recipeBindingMatches
  ) {
    throw new BrokerError("STAGE_APPROVAL_BINDING_INVALID", "project, stage or validation recipe binding mismatch", 409);
  }
  const develop = await readApproval(options, binding.developApprovalId);
  if (
    develop.state !== "executed"
    || develop.kind !== "develop"
    || develop.projectId !== project.id
    || (develop.result as Partial<StageManifest> | undefined)?.id !== stage.id
    || sha256(JSON.stringify(develop.result)) !== binding.developResultHash
    || sha256(JSON.stringify(stage)) !== binding.developResultHash
  ) {
    throw new BrokerError("STAGE_RESULT_TAMPERED", "executed develop approval no longer matches the stage binding", 409);
  }
  const stageHead = (await checkedGit(stage.path, ["rev-parse", "HEAD"])).stdout.trim();
  const stageTree = (await checkedGit(stage.path, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
  const parent = (await checkedGit(stage.path, ["rev-parse", "HEAD^"])).stdout.trim();
  const changed = lines((await checkedGit(stage.path, [
    "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD",
  ])).stdout);
  const diff = await checkedGit(stage.path, ["diff", "--binary", "--no-ext-diff", `${binding.baseCommit}..${binding.candidateCommit}`], {
    maxOutputBytes: 8 * 1024 * 1024,
  });
  if (
    stageHead !== binding.candidateCommit
    || stageTree !== binding.candidateTree
    || parent !== binding.baseCommit
    || sha256(diff.stdout) !== binding.commitDiffHash
    || !sameStrings(changed, binding.allowedPaths)
  ) {
    throw new BrokerError("STAGE_TAMPERED", "stage commit, tree or allowed path set was modified", 409);
  }
  await assertCleanGit(stage.path);
}

async function validateReadyBinding(
  options: BrokerOptions,
  project: ProjectConfig,
  stage: StageManifest,
  binding: ApplyBinding,
  applyApprovalId: string,
): Promise<void> {
  if (binding.applyApprovalId !== applyApprovalId) {
    throw new BrokerError("STAGE_APPROVAL_BINDING_INVALID", "apply approval binding mismatch", 409);
  }
  const applyApproval = await readApproval(options, applyApprovalId);
  if (
    applyApproval.projectId !== project.id
    || applyApproval.kind !== "apply"
    || applyApproval.stageId !== stage.id
    || !["allowed", "running", "executed"].includes(applyApproval.state)
  ) {
    throw new BrokerError("STAGE_APPROVAL_BINDING_INVALID", "apply approval does not point back to the stage", 409);
  }
  await validateFrozenCandidate(options, project, stage, binding, true);
}

async function assertNoActiveApplyApproval(
  options: BrokerOptions,
  projectId: string,
  stageId: string,
): Promise<void> {
  const files = await readdir(path.join(options.dataDir, "approvals"));
  for (const file of files) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\.json$/.test(file)) continue;
    const record = await readApproval(options, file.slice(0, -5)).catch(() => null);
    if (
      record?.kind === "apply"
      && record.projectId === projectId
      && record.stageId === stageId
      && ["pending", "allowed", "running"].includes(record.state)
    ) {
      throw new BrokerError("APPLY_REBIND_CONFLICT", "another apply approval is pending or running for this stage", 409);
    }
  }
}

async function validateFailedApplyRetry(
  options: BrokerOptions,
  project: ProjectConfig,
  stage: StageManifest,
  existing: ApplyBinding,
): Promise<void> {
  if (existing.state !== "ready") {
    throw new BrokerError("STAGE_ALREADY_BOUND", `stage binding is ${existing.state}, not ready`, 409);
  }
  if (await stat(rebindClaimPath(options, existing)).then((value) => value.isFile()).catch(() => false)) {
    throw new BrokerError("APPLY_REBIND_CONFLICT", "this failed binding was already claimed for retry", 409);
  }
  const previous = await readApproval(options, existing.applyApprovalId);
  if (
    previous.state !== "failed"
    || previous.kind !== "apply"
    || previous.projectId !== project.id
    || previous.stageId !== stage.id
  ) {
    throw new BrokerError("APPLY_RETRY_NOT_ALLOWED", "the previous bound apply approval is not a matching failure", 409);
  }
  await assertNoActiveApplyApproval(options, project.id, stage.id);
  await validateFrozenCandidate(options, project, stage, existing, false);
  const liveHash = await fingerprintProject(project);
  if (liveHash !== existing.sourceHash || liveHash !== stage.sourceHash) {
    throw new BrokerError("SOURCE_CHANGED", "live sourceHash drifted from the retry baseline", 409);
  }
  await assertCleanGit(project.realPath, project.applyRecipe!.uid, project.applyRecipe!.gid);
  const liveCommit = (await checkedGit(project.realPath, ["rev-parse", "HEAD"], {
    uid: project.applyRecipe!.uid,
    gid: project.applyRecipe!.gid,
  })).stdout.trim();
  if (liveCommit !== existing.baseCommit) {
    throw new BrokerError("APPLY_RETRY_LIVE_CHANGED", "live HEAD no longer matches the pre-apply baseline", 409);
  }
}

async function rebindFailedApply(
  options: BrokerOptions,
  project: ProjectConfig,
  stage: StageManifest,
  existing: ApplyBinding,
  applyApprovalId: string,
): Promise<Record<string, unknown>> {
  await validateFailedApplyRetry(options, project, stage, existing);
  const claimPayload = {
    schemaVersion: 1,
    projectId: project.id,
    stageId: stage.id,
    previousApplyApprovalId: existing.applyApprovalId,
    applyApprovalId: assertSafeIdentifier(applyApprovalId, "approvalId"),
    candidateCommit: existing.candidateCommit,
    bindingHash: existing.bindingHash,
    createdAt: new Date().toISOString(),
  };
  const claim = {
    ...claimPayload,
    claimHash: sha256(JSON.stringify(claimPayload)),
  };
  const claimPath = rebindClaimPath(options, existing);
  let claimHandle;
  try {
    claimHandle = await open(claimPath, "wx", 0o640);
    await claimHandle.writeFile(`${JSON.stringify(claim, null, 2)}\n`);
    await claimHandle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new BrokerError("APPLY_REBIND_CONFLICT", "this failed binding was already claimed for retry", 409);
    }
    throw error;
  } finally {
    await claimHandle?.close();
  }
  const rebound = await writeApplyBinding(options, {
    ...existing,
    schemaVersion: 3,
    previousApplyApprovalId: existing.applyApprovalId,
    applyApprovalId: assertSafeIdentifier(applyApprovalId, "approvalId"),
    validationRecipeHash: applyRecipeHash(project),
    recipeId: project.applyRecipe!.id,
    recipeVersion: project.applyRecipe!.version,
    recipeConfigHash: project.applyRecipe!.configHash,
    rollbackId: randomUUID(),
    state: "ready",
    rebindCount: (existing.rebindCount ?? 0) + 1,
    reboundAt: new Date().toISOString(),
  });
  return {
    stageId: stage.id,
    developApprovalId: rebound.developApprovalId,
    previousApplyApprovalId: rebound.previousApplyApprovalId,
    retry: true,
    mode: stage.mode,
    applySupported: true,
    allowedPaths: rebound.allowedPaths,
    sourceHash: rebound.sourceHash,
    baseCommit: rebound.baseCommit,
    candidateCommit: rebound.candidateCommit,
    candidateTree: rebound.candidateTree,
    commitDiffHash: rebound.commitDiffHash,
    developResultHash: rebound.developResultHash,
    validationRecipeHash: rebound.validationRecipeHash,
    recipeId: rebound.recipeId,
    recipeVersion: rebound.recipeVersion,
    recipeConfigHash: rebound.recipeConfigHash,
    validationCommands: project.applyRecipe!.verify.length,
    liveProjectWillChangeOnlyAfterOwnerApproval: true,
  };
}

export async function inspectApplyRetryEligibility(
  options: BrokerOptions,
  project: ProjectConfig,
  stageId: string,
): Promise<Record<string, unknown>> {
  const stage = await loadStage(options, assertSafeIdentifier(stageId, "stageId"));
  if (
    stage.projectId !== project.id
    || stage.mode !== "isolated-git"
    || project.sourceMode !== "clean-git"
    || availableApplyRecipes(project).length === 0
  ) {
    throw new BrokerError("APPLY_NOT_SUPPORTED", "only independent clean-Git stages with a fixed recipe may be retried", 403);
  }
  const binding = await readApplyBinding(options, stage.id);
  project = projectForBinding(project, binding, true);
  const recipe = project.applyRecipe!;
  await validateFailedApplyRetry(options, project, stage, binding);
  return {
    eligible: true,
    projectId: project.id,
    stageId: stage.id,
    developApprovalId: binding.developApprovalId,
    failedApplyApprovalId: binding.applyApprovalId,
    sourceHash: binding.sourceHash,
    baseCommit: binding.baseCommit,
    candidateCommit: binding.candidateCommit,
    candidateTree: binding.candidateTree,
    commitDiffHash: binding.commitDiffHash,
    developResultHash: binding.developResultHash,
    validationRecipeHash: applyRecipeHash(project),
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    recipeConfigHash: recipe.configHash,
    validationCommands: recipe.verify.length,
    bindingState: binding.state,
  };
}

export async function recoverFailedPreCommitApply(
  options: BrokerOptions,
  project: ProjectConfig,
  approvalId: string,
  stageId: string,
): Promise<boolean> {
  const id = assertSafeIdentifier(approvalId, "approvalId");
  const stage = await loadStage(options, assertSafeIdentifier(stageId, "stageId"));
  const binding = await readApplyBinding(options, stage.id);
  project = projectForBinding(project, binding, true);
  if (binding.state === "ready") return false;
  const approval = await readApproval(options, id);
  if (
    binding.state !== "applying"
    || binding.applyApprovalId !== id
    || binding.liveCommit !== undefined
    || approval.state !== "failed"
    || approval.kind !== "apply"
    || approval.projectId !== project.id
    || approval.stageId !== stage.id
  ) {
    throw new BrokerError("APPLY_RECOVERY_NOT_SAFE", "failed apply binding is not safe for pre-commit recovery", 409);
  }
  await validateFrozenCandidate(options, project, stage, binding, false);
  const liveHash = await fingerprintProject(project);
  const liveCommit = await currentHead(project);
  await assertCleanGit(project.realPath, project.applyRecipe!.uid, project.applyRecipe!.gid);
  if (liveHash !== binding.sourceHash || liveCommit !== binding.baseCommit) {
    throw new BrokerError("APPLY_RECOVERY_NOT_SAFE", "live changed before failed apply recovery", 409);
  }
  await writeApplyBinding(options, { ...binding, state: "ready" });
  return true;
}

export async function stagePreview(
  options: BrokerOptions,
  project: ProjectConfig,
  stageId: string,
  applyApprovalId: string,
): Promise<Record<string, unknown>> {
  const stage = await loadStage(options, stageId);
  if (
    stage.projectId !== project.id
    || stage.mode !== "isolated-git"
    || project.sourceMode !== "clean-git"
    || availableApplyRecipes(project).length === 0
  ) {
    throw new BrokerError("APPLY_NOT_SUPPORTED", "only independent clean-Git stages with a fixed recipe may be applied", 403);
  }
  const existing = await readApplyBinding(options, stage.id).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    project = projectForBinding(project, existing, true);
    return await rebindFailedApply(options, project, stage, existing, applyApprovalId);
  }
  const { record: develop, resultHash } = await findExecutedDevelopApproval(options, project, stage);
  const status = await checkedGit(stage.path, ["diff", "--name-status", "--no-renames", "HEAD"]);
  const changedPaths = lines(status.stdout).map((entry) => entry.split(/\s+/, 2)).map(([statusCode, file]) => {
    if (statusCode !== "M" || !file) {
      throw new BrokerError("STAGE_SCOPE_VIOLATION", "stage contains a non-modification change", 409);
    }
    return file;
  });
  project = withApplyRecipe(
    project,
    selectApplyRecipe(availableApplyRecipes(project), changedPaths),
  );
  const recipe = project.applyRecipe!;
  const liveHash = await fingerprintProject(project);
  if (liveHash !== stage.sourceHash) throw new BrokerError("SOURCE_CHANGED", "live sourceHash drifted from the stage baseline", 409);
  await assertCleanGit(project.realPath, recipe.uid, recipe.gid);
  const [liveCommit, stageCommit] = await Promise.all([
    checkedGit(project.realPath, ["rev-parse", "HEAD"], {
      uid: recipe.uid, gid: recipe.gid,
    }),
    checkedGit(stage.path, ["rev-parse", "HEAD"]),
  ]);
  const baseCommit = liveCommit.stdout.trim();
  if (stageCommit.stdout.trim() !== baseCommit) {
    throw new BrokerError("STAGE_BASE_MISMATCH", "stage Git baseline does not match live HEAD", 409);
  }
  await checkedGit(stage.path, ["diff", "--check"]);
  const staged = await checkedGit(stage.path, ["diff", "--cached", "--name-only"]);
  if (staged.stdout !== "") throw new BrokerError("STAGE_INDEX_NOT_CLEAN", "stage index must be clean before freezing", 409);
  if (options.serviceUid === undefined || options.serviceGid === undefined) {
    throw new BrokerError("APPLY_NOT_CONFIGURED", "stage service identity is not configured", 500);
  }
  let candidateCommit = "";
  try {
    await checkedGit(stage.path, ["add", "--", ...recipe.allowedPaths], {
      uid: options.serviceUid, gid: options.serviceGid,
    });
    await checkedGit(stage.path, [
      "-c", "user.name=Project Ops",
      "-c", "user.email=project-ops@localhost",
      "commit", "--no-gpg-sign",
      "-m", `project-ops apply ${applyApprovalId} from stage ${stage.id}`,
    ], { uid: options.serviceUid, gid: options.serviceGid });
    candidateCommit = (await checkedGit(stage.path, ["rev-parse", "HEAD"])).stdout.trim();
    const candidateTree = (await checkedGit(stage.path, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    const commitDiff = await checkedGit(stage.path, [
      "diff", "--binary", "--no-ext-diff", `${baseCommit}..${candidateCommit}`,
    ], { maxOutputBytes: 8 * 1024 * 1024 });
    const binding = await writeApplyBinding(options, {
      schemaVersion: 3,
      projectId: project.id,
      stageId: stage.id,
      developApprovalId: develop.id,
      applyApprovalId: assertSafeIdentifier(applyApprovalId, "approvalId"),
      developResultHash: resultHash,
      sourceHash: stage.sourceHash,
      baseCommit,
      candidateCommit,
      candidateTree,
      commitDiffHash: sha256(commitDiff.stdout),
      validationRecipeHash: applyRecipeHash(project),
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      recipeConfigHash: recipe.configHash,
      allowedPaths: [...recipe.allowedPaths],
      rollbackId: randomUUID(),
      state: "ready",
      createdAt: new Date().toISOString(),
    });
    await assertCleanGit(stage.path);
    return {
      stageId: stage.id,
      developApprovalId: develop.id,
      mode: stage.mode,
      applySupported: true,
      allowedPaths: binding.allowedPaths,
      baseCommit,
      candidateCommit,
      candidateTree,
      commitDiffHash: binding.commitDiffHash,
      developResultHash: resultHash,
      validationRecipeHash: binding.validationRecipeHash,
      recipeId: binding.recipeId,
      recipeVersion: binding.recipeVersion,
      recipeConfigHash: binding.recipeConfigHash,
      validationCommands: recipe.verify.length,
      liveProjectWillChangeOnlyAfterOwnerApproval: true,
    };
  } catch (error) {
    if (candidateCommit) {
      await checkedGit(stage.path, ["reset", "--mixed", baseCommit], {
        uid: options.serviceUid, gid: options.serviceGid,
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function importCandidateCommit(
  options: BrokerOptions,
  project: ProjectConfig,
  stage: StageManifest,
  binding: ApplyBinding,
): Promise<void> {
  if (!project.applyRecipe || options.serviceUid === undefined || options.serviceGid === undefined) {
    throw new BrokerError("APPLY_NOT_CONFIGURED", "fixed apply identities are not configured", 500);
  }
  const bundleDirectory = options.applyBundleDirectory ?? "/tmp";
  if (!path.isAbsolute(bundleDirectory)) {
    throw new BrokerError("APPLY_NOT_CONFIGURED", "apply bundle directory must be absolute", 500);
  }
  const bundlePath = path.join(
    bundleDirectory,
    `project-ops-apply-${assertSafeIdentifier(binding.applyApprovalId, "approvalId")}.bundle`,
  );
  await rm(bundlePath, { force: true });
  try {
    await checkedGit(stage.path, ["bundle", "create", bundlePath, "HEAD"], {
      uid: options.serviceUid, gid: options.serviceGid, timeoutMs: 120_000,
    });
    await lchown(bundlePath, project.applyRecipe.uid, project.applyRecipe.gid);
    await checkedGit(project.realPath, ["fetch", "--no-tags", bundlePath, "HEAD"], {
      uid: project.applyRecipe.uid, gid: project.applyRecipe.gid, timeoutMs: 120_000,
    });
    const fetched = (await checkedGit(project.realPath, ["rev-parse", "FETCH_HEAD"], {
      uid: project.applyRecipe.uid, gid: project.applyRecipe.gid,
    })).stdout.trim();
    if (fetched !== binding.candidateCommit) throw new BrokerError("STAGE_TAMPERED", "imported commit does not match binding", 409);
  } finally {
    await rm(bundlePath, { force: true });
  }
}

async function currentHead(project: ProjectConfig): Promise<string> {
  if (!project.applyRecipe) throw new BrokerError("APPLY_RECIPE_MISSING", "fixed apply recipe is missing", 403);
  return (await checkedGit(project.realPath, ["rev-parse", "HEAD"], {
    uid: project.applyRecipe.uid, gid: project.applyRecipe.gid,
  })).stdout.trim();
}

async function writeRollbackManifest(
  options: BrokerOptions,
  binding: ApplyBinding,
  liveCommit: string,
): Promise<RollbackManifest> {
  const payload = {
    schemaVersion: 2 as const,
    id: binding.rollbackId,
    projectId: binding.projectId,
    stageId: binding.stageId,
    applyApprovalId: binding.applyApprovalId,
    liveCommit,
    state: "ready" as const,
    createdAt: new Date().toISOString(),
  };
  const manifest = withIntegrity(payload, "manifestHash") as RollbackManifest;
  const target = rollbackManifestPath(options, binding.projectId, binding.rollbackId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
  await writeJsonAtomic(target, manifest);
  return manifest;
}

async function rollbackFailedApply(
  options: BrokerOptions,
  project: ProjectConfig,
  binding: ApplyBinding,
  liveCommit: string,
): Promise<void> {
  if (!project.applyRecipe) return;
  const reverted = await checkedGit(project.realPath, [
    "-c", "user.name=Project Ops",
    "-c", "user.email=project-ops@localhost",
    "revert", "--no-edit", liveCommit,
  ], { uid: project.applyRecipe.uid, gid: project.applyRecipe.gid });
  const rollbackCommit = (await currentHead(project)).trim();
  await writeApplyBinding(options, {
    ...binding,
    state: "rolled-back",
    liveCommit,
    rollbackCommit,
    appliedAt: new Date().toISOString(),
  });
  await runApplyVerification(
    options,
    project,
    project.realPath,
    project.applyRecipe.uid,
    project.applyRecipe.gid,
    "failed-apply-rollback",
    `live:${project.id}`,
    binding,
  );
  await assertCleanGit(project.realPath, project.applyRecipe.uid, project.applyRecipe.gid);
  if (reverted.code !== 0) throw new BrokerError("APPLY_ROLLBACK_FAILED", "failed apply could not be rolled back", 500);
}

export async function applyStage(
  options: BrokerOptions,
  project: ProjectConfig,
  stageId: string,
  applyApprovalId: string,
): Promise<Record<string, unknown>> {
  const stage = await loadStage(options, stageId);
  const binding = await readApplyBinding(options, stage.id);
  project = projectForBinding(project, binding, false);
  if (binding.state === "rolled-back") throw new BrokerError("APPLY_ALREADY_ROLLED_BACK", "apply was already rolled back", 409);
  await validateReadyBinding(options, project, stage, binding, applyApprovalId);
  if (binding.state === "applied") {
    if (await currentHead(project) !== binding.liveCommit) {
      throw new BrokerError("APPLY_RESULT_DRIFTED", "live HEAD no longer matches the applied commit", 409);
    }
    return {
      applied: true,
      stageId,
      developApprovalId: binding.developApprovalId,
      candidateCommit: binding.candidateCommit,
      liveCommit: binding.liveCommit,
      rollbackId: binding.rollbackId,
      recovered: true,
    };
  }
  await assertCleanGit(project.realPath, project.applyRecipe!.uid, project.applyRecipe!.gid);
  const headBefore = await currentHead(project);
  if (binding.state === "ready" || headBefore === binding.baseCommit) {
    const liveHash = await fingerprintProject(project);
    if (liveHash !== binding.sourceHash) {
      throw new BrokerError("SOURCE_CHANGED", "live sourceHash drifted from the frozen baseline", 409);
    }
  }
  if (binding.state === "ready" && headBefore !== binding.baseCommit) {
    throw new BrokerError("SOURCE_CHANGED", "live Git commit drifted from the frozen baseline", 409);
  }
  await runStageSetup(options, project, stage);
  await runApplyVerification(
    options,
    project,
    stage.path,
    options.serviceUid!,
    options.serviceGid!,
    "stage-pre-apply",
    `stage:${stage.id}`,
    binding,
  );
  if (headBefore === binding.baseCommit) {
    await runApplyVerification(
      options,
      project,
      project.realPath,
      project.applyRecipe!.uid,
      project.applyRecipe!.gid,
      "live-pre-apply",
      `live:${project.id}`,
      binding,
    );
  }
  let activeBinding = binding;
  if (binding.state === "ready") {
    activeBinding = await writeApplyBinding(options, { ...binding, state: "applying" });
  }
  let liveCommit: string;
  if (headBefore === binding.baseCommit) {
    try {
      await importCandidateCommit(options, project, stage, activeBinding);
      await checkedGit(project.realPath, ["cherry-pick", binding.candidateCommit], {
        uid: project.applyRecipe!.uid, gid: project.applyRecipe!.gid, timeoutMs: 120_000,
      });
      liveCommit = await currentHead(project);
    } catch (error) {
      const headAfterFailure = await currentHead(project).catch(() => "");
      const liveStillClean = await assertCleanGit(
        project.realPath,
        project.applyRecipe!.uid,
        project.applyRecipe!.gid,
      ).then(() => true, () => false);
      if (headAfterFailure === binding.baseCommit && liveStillClean) {
        await writeApplyBinding(options, { ...activeBinding, state: "ready" });
      }
      throw error;
    }
  } else {
    liveCommit = headBefore;
  }
  const [parent, tree, changed] = await Promise.all([
    checkedGit(project.realPath, ["rev-parse", `${liveCommit}^`], {
      uid: project.applyRecipe!.uid, gid: project.applyRecipe!.gid,
    }),
    checkedGit(project.realPath, ["rev-parse", `${liveCommit}^{tree}`], {
      uid: project.applyRecipe!.uid, gid: project.applyRecipe!.gid,
    }),
    checkedGit(project.realPath, ["diff-tree", "--no-commit-id", "--name-only", "-r", liveCommit], {
      uid: project.applyRecipe!.uid, gid: project.applyRecipe!.gid,
    }),
  ]);
  if (
    parent.stdout.trim() !== binding.baseCommit
    || tree.stdout.trim() !== binding.candidateTree
    || !sameStrings(lines(changed.stdout), binding.allowedPaths)
  ) {
    throw new BrokerError("APPLY_COMMIT_MISMATCH", "live commit does not match the frozen candidate", 409);
  }
  try {
    await runApplyVerification(
      options,
      project,
      project.realPath,
      project.applyRecipe!.uid,
      project.applyRecipe!.gid,
      "live-post-apply",
      `live:${project.id}`,
      activeBinding,
    );
    await assertCleanGit(project.realPath, project.applyRecipe!.uid, project.applyRecipe!.gid);
  } catch (error) {
    await rollbackFailedApply(options, project, activeBinding, liveCommit);
    if (error instanceof ApplyValidationError) throw error.afterRollback();
    throw new BrokerError("POST_VALIDATION_FAILED_ROLLED_BACK", "post-apply validation failed and the commit was reverted", 409);
  }
  await writeRollbackManifest(options, activeBinding, liveCommit);
  activeBinding = await writeApplyBinding(options, {
    ...activeBinding,
    state: "applied",
    liveCommit,
    appliedAt: new Date().toISOString(),
  });
  return {
    applied: true,
    stageId,
    developApprovalId: activeBinding.developApprovalId,
    candidateCommit: activeBinding.candidateCommit,
    liveCommit,
    rollbackId: activeBinding.rollbackId,
  };
}

async function readRollbackManifest(
  options: BrokerOptions,
  project: ProjectConfig,
  snapshotId: string,
): Promise<RollbackManifest> {
  const parsed = JSON.parse(await readFile(rollbackManifestPath(options, project.id, snapshotId), "utf8")) as RollbackManifest;
  const { manifestHash, ...payload } = parsed;
  if (
    parsed.schemaVersion !== 2
    || parsed.id !== snapshotId
    || parsed.projectId !== project.id
    || typeof manifestHash !== "string"
    || manifestHash !== sha256(JSON.stringify(payload))
  ) {
    throw new BrokerError("ROLLBACK_CORRUPT", "rollback manifest failed integrity validation", 409);
  }
  return parsed;
}

export async function rollbackPreview(options: BrokerOptions, project: ProjectConfig, snapshotId: string): Promise<Record<string, unknown>> {
  const manifest = await readRollbackManifest(options, project, assertSafeIdentifier(snapshotId, "snapshotId"));
  if (manifest.state !== "ready") throw new BrokerError("ROLLBACK_REPLAY", "rollback was already executed", 409);
  const binding = await readApplyBinding(options, manifest.stageId);
  project = projectForBinding(project, binding, false);
  const canApply = await currentHead(project) === manifest.liveCommit;
  return {
    snapshotId,
    projectId: project.id,
    stageId: manifest.stageId,
    liveCommit: manifest.liveCommit,
    canApply,
  };
}

export async function applyRollback(
  options: BrokerOptions,
  project: ProjectConfig,
  snapshotId: string,
  rollbackApprovalId: string,
): Promise<Record<string, unknown>> {
  const manifest = await readRollbackManifest(options, project, snapshotId);
  const preview = await rollbackPreview(options, project, snapshotId);
  if (!preview.canApply || manifest.state !== "ready") {
    throw new BrokerError("ROLLBACK_CONFLICT", "rollback no longer applies to current live HEAD", 409);
  }
  const binding = await readApplyBinding(options, manifest.stageId);
  project = projectForBinding(project, binding, false);
  const recipe = project.applyRecipe!;
  if (
    binding.projectId !== project.id
    || binding.applyApprovalId !== manifest.applyApprovalId
    || binding.liveCommit !== manifest.liveCommit
  ) {
    throw new BrokerError("ROLLBACK_CORRUPT", "rollback no longer matches its apply binding", 409);
  }
  await runApplyVerification(
    options,
    project,
    project.realPath,
    recipe.uid,
    recipe.gid,
    "rollback-pre-check",
    `live:${project.id}`,
    binding,
  );
  await checkedGit(project.realPath, [
    "-c", "user.name=Project Ops",
    "-c", "user.email=project-ops@localhost",
    "revert", "--no-edit", manifest.liveCommit,
  ], { uid: recipe.uid, gid: recipe.gid });
  const rollbackCommit = await currentHead(project);
  await runApplyVerification(
    options,
    project,
    project.realPath,
    recipe.uid,
    recipe.gid,
    "rollback-post-check",
    `live:${project.id}`,
    binding,
  );
  await assertCleanGit(project.realPath, recipe.uid, recipe.gid);
  const updated = withIntegrity({
    ...manifest,
    state: "rolled-back" as const,
    rollbackCommit,
    rolledBackAt: new Date().toISOString(),
    rollbackApprovalId: assertSafeIdentifier(rollbackApprovalId, "approvalId"),
  }, "manifestHash") as unknown as RollbackManifest;
  await writeJsonAtomic(rollbackManifestPath(options, project.id, snapshotId), updated);
  return { rolledBack: true, snapshotId, liveCommit: manifest.liveCommit, rollbackCommit };
}
