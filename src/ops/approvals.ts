import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuditLog } from "./audit.js";
import { assertWriteBudget } from "./budget.js";
import { BrokerError } from "./errors.js";
import { fingerprintProject } from "./fingerprint.js";
import { runCommand } from "./process.js";
import { assertCapability, getProject, loadRegistry } from "./registry.js";
import {
  assertOwner,
  assertSafeIdentifier,
  redactDiagnosticText,
  redactObject,
  requestSummary,
  sha256,
} from "./security.js";
import {
  ApplyValidationError,
  applyRollback,
  applyStage,
  createStage,
  discardStageForRecovery,
  persistApplyValidationFailure,
  persistStageFailure,
  recoverFailedPreCommitApply,
  rollbackPreview,
  stageIdFromError,
  stagePreview,
} from "./staging.js";
import type {
  ApplyValidationPhase,
  SandboxStage,
  StageManifest,
  ValidationCommandDiagnostic,
} from "./staging.js";
import type {
  Actor,
  ApprovalDecision,
  ApprovalRecord,
  BrokerOptions,
  ChangeKind,
  PrepareRequest,
  ProjectConfig,
} from "./types.js";

const MAX_FAILURE_FILE_BYTES = 64 * 1024;
const SANDBOX_STAGES = new Set<SandboxStage>([
  "process-spawn",
  "authentication",
  "sandbox-startup",
  "source-validation",
  "apply-validation",
  "stage-creation",
  "task-execution",
  "execution-timeout",
  "broker-recovery",
  "result-persistence",
]);
const APPLY_VALIDATION_PHASES = new Set<ApplyValidationPhase>([
  "stage-pre-apply",
  "live-pre-apply",
  "live-post-apply",
  "failed-apply-rollback",
  "rollback-pre-check",
  "rollback-post-check",
]);

function validationDiagnostic(value: unknown): ValidationCommandDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const { resultHash, ...payload } = item;
  if (
    !Number.isSafeInteger(item.commandIndex)
    || Number(item.commandIndex) < 1
    || Number(item.commandIndex) > 8
    || typeof item.commandId !== "string"
    || !/^[a-f0-9]{64}$/.test(item.commandId)
    || typeof item.startedAt !== "string"
    || !Number.isFinite(Date.parse(item.startedAt))
    || typeof item.finishedAt !== "string"
    || !Number.isFinite(Date.parse(item.finishedAt))
    || Date.parse(item.finishedAt) < Date.parse(item.startedAt)
    || !(item.exitCode === null || (typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode)))
    || !(item.signal === null || (typeof item.signal === "string" && item.signal.length <= 32))
    || typeof item.timeout !== "boolean"
    || typeof item.outputTruncated !== "boolean"
    || typeof item.stdout !== "string"
    || typeof item.stderr !== "string"
    || typeof item.cwd !== "string"
    || !/^(?:stage|live):[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(item.cwd)
    || !Number.isSafeInteger(item.uid)
    || !Number.isSafeInteger(item.gid)
    || typeof resultHash !== "string"
    || !/^[a-f0-9]{64}$/.test(resultHash)
    || resultHash !== sha256(JSON.stringify(payload))
  ) {
    return null;
  }
  const safePayload = {
    commandIndex: item.commandIndex as number,
    commandId: item.commandId,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
    exitCode: item.exitCode as number | null,
    signal: item.signal as NodeJS.Signals | null,
    timeout: item.timeout,
    outputTruncated: item.outputTruncated,
    stdout: redactDiagnosticText(item.stdout, ""),
    stderr: redactDiagnosticText(item.stderr, ""),
    cwd: item.cwd,
    uid: item.uid as number,
    gid: item.gid as number,
  };
  return {
    ...safePayload,
    resultHash: sha256(JSON.stringify(safePayload)),
  } as ValidationCommandDiagnostic;
}

export interface FailureResult {
  approvalId: string;
  stageId: string;
  state: "failed";
  sandboxStage: SandboxStage;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  resultHash: string;
  createdAt: string;
  timeout?: boolean;
  developApprovalId?: string;
  candidateCommit?: string;
  validationPhase?: ApplyValidationPhase;
  validationResults?: ValidationCommandDiagnostic[];
}

export interface ApprovalStatus {
  approvalId: string;
  projectId: string;
  kind: ChangeKind;
  state: ApprovalRecord["state"];
  stageId?: string;
  createdAt: string;
  decisionAt?: string;
  startedAt?: string;
  heartbeatAt?: string;
  executionDeadlineAt?: string;
  executedAt?: string;
  failedAt?: string;
  failure?: string;
  resultHash?: string;
}

export class ApprovalService {
  readonly options: BrokerOptions;
  readonly audit: AuditLog;
  #queue: Promise<unknown> = Promise.resolve();
  #active = new Map<string, Promise<void>>();
  #instanceId = randomUUID();
  #sweepTimer: NodeJS.Timeout | undefined;
  #started = false;

  constructor(options: BrokerOptions) {
    this.options = options;
    this.audit = new AuditLog(options.dataDir);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private executionTimeoutMs(): number {
    return this.options.executionTimeoutMs ?? 45 * 60_000;
  }

  private heartbeatIntervalMs(): number {
    return this.options.heartbeatIntervalMs ?? 10_000;
  }

  private leaseDurationMs(): number {
    return this.options.leaseDurationMs ?? Math.max(30_000, this.heartbeatIntervalMs() * 3);
  }

  private orphanSweepIntervalMs(): number {
    return this.options.orphanSweepIntervalMs ?? this.heartbeatIntervalMs();
  }

  private approvalsDir(): string {
    return path.join(this.options.dataDir, "approvals");
  }

  private approvalPath(id: string): string {
    return path.join(this.approvalsDir(), `${assertSafeIdentifier(id, "approvalId")}.json`);
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.then(() => undefined, () => undefined);
    return await next;
  }

  private async write(record: ApprovalRecord, exclusive = false): Promise<void> {
    await mkdir(this.approvalsDir(), { recursive: true, mode: 0o750 });
    const target = this.approvalPath(record.id);
    if (exclusive) {
      const handle = await open(target, "wx", 0o640);
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o640 });
    await rename(temporary, target);
  }

  async load(id: string): Promise<ApprovalRecord> {
    const record = JSON.parse(await readFile(this.approvalPath(id), "utf8")) as ApprovalRecord;
    if (record.schemaVersion !== 1 || record.id !== id) throw new BrokerError("INVALID_APPROVAL", "approval record is invalid");
    return record;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await mkdir(this.approvalsDir(), { recursive: true, mode: 0o750 });
    const files = await readdir(this.approvalsDir());
    for (const file of files) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\.json$/.test(file)) continue;
      const id = file.slice(0, -5);
      const record = await this.load(id).catch(() => null);
      if (record?.state === "allowed") {
        void this.beginExecution(id, undefined, "broker-restart").catch((error) => this.auditWorkerError(id, error));
      } else if (record?.state === "running") {
        void this.recoverRunning(id, "broker-restart").catch((error) => this.auditWorkerError(id, error));
      } else if (record?.state === "failed" && record.kind === "apply" && record.stageId) {
        try {
          const recovered = await recoverFailedPreCommitApply(
            this.options,
            await this.project(record.projectId),
            record.id,
            record.stageId,
          );
          if (recovered) {
            await this.audit.append({
              event: "apply.precommit_recovered",
              approvalId: record.id,
              projectId: record.projectId,
              stageId: record.stageId,
            });
          }
        } catch (error) {
          await this.auditWorkerError(id, error);
        }
      }
    }
    this.#sweepTimer = setInterval(() => {
      void this.sweepOrphans().catch((error) => this.auditWorkerError("sweep", error));
    }, this.orphanSweepIntervalMs());
    this.#sweepTimer.unref();
  }

  stop(): void {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
    this.#started = false;
  }

  async status(id: string, actor: Actor): Promise<ApprovalStatus> {
    assertOwner(actor, this.options.ownerId);
    const record = await this.load(assertSafeIdentifier(id, "approvalId"));
    if (record.ownerId !== actor.senderId) {
      throw new BrokerError("APPROVAL_OWNER_MISMATCH", "approval belongs to another owner", 403);
    }
    return this.statusFrom(record);
  }

  async waitForTerminal(id: string, timeoutMs = 10_000): Promise<ApprovalRecord> {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const record = await this.load(id);
      if (["executed", "failed", "denied", "expired"].includes(record.state)) return record;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new BrokerError("WAIT_TIMEOUT", "approval did not reach a terminal state in time", 504);
  }

  private statusFrom(record: ApprovalRecord): ApprovalStatus {
    return {
      approvalId: record.id,
      projectId: record.projectId,
      kind: record.kind,
      state: record.state,
      ...(record.stageId === undefined ? {} : { stageId: record.stageId }),
      createdAt: record.createdAt,
      ...(record.decisionAt === undefined ? {} : { decisionAt: record.decisionAt }),
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      ...(record.heartbeatAt === undefined ? {} : { heartbeatAt: record.heartbeatAt }),
      ...(record.executionDeadlineAt === undefined ? {} : { executionDeadlineAt: record.executionDeadlineAt }),
      ...(record.executedAt === undefined ? {} : { executedAt: record.executedAt }),
      ...(record.failedAt === undefined ? {} : { failedAt: record.failedAt }),
      ...(record.failure === undefined ? {} : { failure: redactDiagnosticText(record.failure, record.requestBody, 500) }),
      ...(record.result === undefined ? {} : { resultHash: sha256(JSON.stringify(record.result)) }),
    };
  }

  async failureResult(id: string, actor: Actor): Promise<FailureResult> {
    assertOwner(actor, this.options.ownerId);
    const approvalId = assertSafeIdentifier(id, "approvalId");
    let record: ApprovalRecord;
    try {
      record = await this.load(approvalId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BrokerError("APPROVAL_NOT_FOUND", "approval was not found", 404);
      }
      throw error;
    }
    if (record.ownerId !== actor.senderId) {
      throw new BrokerError("APPROVAL_OWNER_MISMATCH", "approval belongs to another owner", 403);
    }
    if (record.state !== "failed") {
      throw new BrokerError("FAILURE_RESULT_UNAVAILABLE", `approval is ${record.state}`, 409);
    }
    const primaryStageId = assertSafeIdentifier(record.stageId ?? record.diagnosticStageId ?? "", "stageId");
    const diagnosticCandidates = [
      {
        path: path.join(this.options.dataDir, "tasks", `${approvalId}.failure.json`),
        expectedStageId: primaryStageId,
      },
      {
        path: path.join(this.options.dataDir, "tasks", `${primaryStageId}.failure.json`),
        expectedStageId: primaryStageId,
      },
      ...(record.diagnosticStageId && record.diagnosticStageId !== approvalId ? [{
        path: path.join(
          this.options.dataDir,
          "tasks",
          `${assertSafeIdentifier(record.diagnosticStageId, "diagnosticStageId")}.failure.json`,
        ),
        expectedStageId: assertSafeIdentifier(record.diagnosticStageId, "diagnosticStageId"),
      }] : []),
    ];
    let handle;
    let stageId = primaryStageId;
    for (const candidate of diagnosticCandidates) {
      try {
        handle = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        stageId = candidate.expectedStageId;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new BrokerError("FAILURE_RESULT_INVALID", "failure result could not be read", 409);
        }
      }
    }
    if (!handle) throw new BrokerError("FAILURE_RESULT_NOT_FOUND", "failure result was not found", 404);
    let raw: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FAILURE_FILE_BYTES) {
        throw new BrokerError("FAILURE_RESULT_INVALID", "failure result is invalid", 409);
      }
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    let diagnostic: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid JSON object");
      diagnostic = parsed as Record<string, unknown>;
    } catch {
      throw new BrokerError("FAILURE_RESULT_INVALID", "failure result is invalid", 409);
    }
    const { resultHash, ...payload } = diagnostic;
    const schemaVersion = diagnostic.schemaVersion;
    if (
      ![1, 2].includes(Number(schemaVersion))
      || diagnostic.approvalId !== approvalId
      || diagnostic.stageId !== stageId
      || typeof diagnostic.sandboxStage !== "string"
      || !SANDBOX_STAGES.has(diagnostic.sandboxStage as SandboxStage)
      || !(diagnostic.exitCode === null || (typeof diagnostic.exitCode === "number" && Number.isSafeInteger(diagnostic.exitCode)))
      || !(diagnostic.signal === null || (typeof diagnostic.signal === "string" && diagnostic.signal.length <= 32))
      || typeof diagnostic.stdout !== "string"
      || typeof diagnostic.stderr !== "string"
      || typeof diagnostic.createdAt !== "string"
      || !Number.isFinite(Date.parse(diagnostic.createdAt))
      || typeof resultHash !== "string"
      || !/^[a-f0-9]{64}$/.test(resultHash)
      || resultHash !== sha256(JSON.stringify(payload))
    ) {
      throw new BrokerError("FAILURE_RESULT_INVALID", "failure result binding or integrity check failed", 409);
    }
    const base: FailureResult = {
      approvalId,
      stageId,
      state: "failed",
      sandboxStage: diagnostic.sandboxStage as FailureResult["sandboxStage"],
      exitCode: diagnostic.exitCode as number | null,
      signal: diagnostic.signal as string | null,
      stdout: redactDiagnosticText(diagnostic.stdout, ""),
      stderr: redactDiagnosticText(diagnostic.stderr, ""),
      resultHash,
      createdAt: diagnostic.createdAt,
    };
    if (schemaVersion === 1) return base;
    const rawResults = diagnostic.validationResults;
    const results = Array.isArray(rawResults) ? rawResults.map(validationDiagnostic) : [];
    const failed = results.at(-1);
    if (
      record.kind !== "apply"
      || diagnostic.state !== "failed"
      || diagnostic.sandboxStage !== "apply-validation"
      || typeof diagnostic.developApprovalId !== "string"
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(diagnostic.developApprovalId)
      || typeof diagnostic.candidateCommit !== "string"
      || !/^[a-f0-9]{40,64}$/.test(diagnostic.candidateCommit)
      || typeof diagnostic.validationPhase !== "string"
      || !APPLY_VALIDATION_PHASES.has(diagnostic.validationPhase as ApplyValidationPhase)
      || !Array.isArray(rawResults)
      || rawResults.length < 1
      || rawResults.length > 8
      || results.some((entry) => entry === null)
      || !failed
      || diagnostic.exitCode !== failed.exitCode
      || diagnostic.signal !== failed.signal
      || diagnostic.timeout !== failed.timeout
    ) {
      throw new BrokerError("FAILURE_RESULT_INVALID", "apply validation result is invalid", 409);
    }
    return {
      ...base,
      timeout: diagnostic.timeout as boolean,
      developApprovalId: diagnostic.developApprovalId,
      candidateCommit: diagnostic.candidateCommit,
      validationPhase: diagnostic.validationPhase as ApplyValidationPhase,
      validationResults: results as ValidationCommandDiagnostic[],
    };
  }

  private async project(projectId: string): Promise<ProjectConfig> {
    return getProject(await loadRegistry(this.options.registryPath), projectId);
  }

  async prepare(input: PrepareRequest): Promise<ApprovalRecord> {
    return await this.serialize(() => this.prepareLocked(input));
  }

  private async prepareLocked(input: PrepareRequest): Promise<ApprovalRecord> {
    assertOwner(input.actor, this.options.ownerId);
    const project = await this.project(input.projectId);
    assertCapability(project, input.kind);
    await assertWriteBudget(this.options, input.kind);
    const summary = requestSummary(input.request);
    const sourceHash = await fingerprintProject(project);
    const id = randomUUID();
    const preview = await this.buildPreview(project, input.kind, input.stageId, input.snapshotId, id);
    const now = this.now();
    const record: ApprovalRecord = {
      schemaVersion: 1,
      id,
      projectId: project.id,
      kind: input.kind,
      requestSummary: summary,
      requestBody: input.request,
      requestHash: sha256(input.request),
      sourceHash,
      preview: redactObject(preview),
      ...(input.stageId === undefined ? {} : { stageId: assertSafeIdentifier(input.stageId, "stageId") }),
      ...(input.snapshotId === undefined ? {} : { snapshotId: assertSafeIdentifier(input.snapshotId, "snapshotId") }),
      ownerId: input.actor.senderId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.options.approvalTtlMs).toISOString(),
      state: "pending",
    };
    await this.write(record, true);
    await this.audit.append({
      event: "approval.prepared",
      approvalId: record.id,
      projectId: record.projectId,
      kind: record.kind,
      ownerIdHash: sha256(record.ownerId),
      requestHash: record.requestHash,
      sourceHash: record.sourceHash,
      expiresAt: record.expiresAt,
    });
    return record;
  }

  private async buildPreview(
    project: ProjectConfig,
    kind: ChangeKind,
    stageId?: string,
    snapshotId?: string,
    approvalId?: string,
  ): Promise<unknown> {
    if (["start", "stop", "restart"].includes(kind)) {
      const commands = project.actions[kind as keyof ProjectConfig["actions"]];
      if (!commands?.length) throw new BrokerError("RECIPE_MISSING", "no fixed action recipe is registered", 403);
      return { kind, commands, confirmation: "service state will change only after owner approval" };
    }
    if (kind === "develop") {
      if (project.sourceMode === "clean-git") {
        const clean = await runCommand([
          "/usr/bin/git", "-c", `safe.directory=${project.realPath}`, "-C", project.realPath,
          "status", "--porcelain=v1", "--untracked-files=all",
        ], { maxOutputBytes: 256 * 1024 });
        if (clean.code !== 0 || clean.stdout.length > 0) {
          throw new BrokerError("WORKTREE_NOT_CLEAN", "registered clean Git project is dirty; staging is refused", 409);
        }
      }
      return {
        kind,
        sourceMode: project.sourceMode,
        liveProjectWillChange: false,
        next: "create an isolated stage and run the constrained Codex subprocess",
      };
    }
    if (kind === "apply") {
      if (!stageId) throw new BrokerError("STAGE_REQUIRED", "stageId is required for apply");
      if (!approvalId) throw new BrokerError("INVALID_APPROVAL", "apply approval id was not allocated");
      return await stagePreview(this.options, project, stageId, approvalId);
    }
    if (kind === "rollback") {
      if (!snapshotId) throw new BrokerError("SNAPSHOT_REQUIRED", "snapshotId is required for rollback");
      return await rollbackPreview(this.options, project, snapshotId);
    }
    throw new BrokerError("RECIPE_MISSING", "deployment is denied until a fixed project recipe is registered", 403);
  }

  async decide(id: string, decision: ApprovalDecision, actor: Actor): Promise<ApprovalRecord> {
    return await this.serialize(async () => {
      assertOwner(actor, this.options.ownerId);
      const record = await this.load(id);
      if (record.ownerId !== actor.senderId) throw new BrokerError("APPROVAL_OWNER_MISMATCH", "approval belongs to another owner", 403);
      if (record.state !== "pending") throw new BrokerError("APPROVAL_REPLAY", `approval is already ${record.state}`, 409);
      if (this.now().getTime() > Date.parse(record.expiresAt)) {
        record.state = "expired";
        await this.write(record);
        throw new BrokerError("APPROVAL_EXPIRED", "approval expired", 410);
      }
      record.state = decision === "allow" ? "allowed" : "denied";
      record.decisionAt = this.now().toISOString();
      await this.write(record);
      await this.audit.append({
        event: "approval.decided",
        approvalId: record.id,
        projectId: record.projectId,
        decision,
        ownerIdHash: sha256(actor.senderId),
      });
      return record;
    });
  }

  async execute(id: string, actor: Actor): Promise<ApprovalStatus> {
    assertOwner(actor, this.options.ownerId);
    return this.statusFrom(await this.beginExecution(id, actor, "api-request"));
  }

  private async beginExecution(
    id: string,
    actor: Actor | undefined,
    reason: "api-request" | "broker-restart" | "orphan-recovery",
  ): Promise<ApprovalRecord> {
    const record = await this.serialize(async () => {
      const current = await this.load(assertSafeIdentifier(id, "approvalId"));
      if (actor && current.ownerId !== actor.senderId) {
        throw new BrokerError("APPROVAL_OWNER_MISMATCH", "approval belongs to another owner", 403);
      }
      if (current.state !== "allowed") {
        const code = current.state === "running" ? "APPROVAL_IN_PROGRESS" : "APPROVAL_NOT_ALLOWED";
        throw new BrokerError(code, `approval is ${current.state}`, 409);
      }
      if (this.now().getTime() > Date.parse(current.expiresAt)) {
        current.state = "expired";
        await this.write(current);
        throw new BrokerError("APPROVAL_EXPIRED", "approval expired", 410);
      }
      const now = this.now();
      const attemptId = randomUUID();
      current.state = "running";
      current.startedAt = current.startedAt ?? now.toISOString();
      current.heartbeatAt = now.toISOString();
      current.executionDeadlineAt = current.executionDeadlineAt
        ?? new Date(now.getTime() + this.executionTimeoutMs()).toISOString();
      current.attemptId = attemptId;
      current.leaseOwner = this.#instanceId;
      current.leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs()).toISOString();
      current.recoveryCount = current.recoveryCount ?? 0;
      current.diagnosticStageId = ["develop", "apply"].includes(current.kind)
        ? (current.stageId ?? randomUUID())
        : randomUUID();
      if (current.kind === "develop") current.stageId = current.diagnosticStageId;
      await this.write(current);
      await this.audit.append({
        event: "approval.running",
        approvalId: current.id,
        projectId: current.projectId,
        kind: current.kind,
        attemptIdHash: sha256(attemptId),
        reason,
        deadline: current.executionDeadlineAt,
      });
      return current;
    });
    this.launch(record.id, record.attemptId!, false);
    return record;
  }

  private launch(id: string, attemptId: string, recovering: boolean): void {
    if (this.#active.has(id)) return;
    const worker = this.runAttempt(id, attemptId, recovering)
      .catch((error) => this.auditWorkerError(id, error))
      .finally(() => {
        if (this.#active.get(id) === worker) this.#active.delete(id);
      });
    this.#active.set(id, worker);
  }

  private async runAttempt(id: string, attemptId: string, recovering: boolean): Promise<void> {
    let record = await this.load(id);
    if (record.state !== "running" || record.attemptId !== attemptId) return;
    let project: ProjectConfig | undefined;
    const heartbeat = setInterval(() => {
      void this.touchLease(id, attemptId).catch((error) => this.auditWorkerError(id, error));
    }, this.heartbeatIntervalMs());
    heartbeat.unref();
    try {
      project = await this.project(record.projectId);
      if (recovering && record.kind === "develop" && record.stageId) {
        await discardStageForRecovery(this.options, project, record.stageId);
      }
      const remainingMs = this.remainingExecutionMs(record);
      const currentHash = await fingerprintProject(project);
      if (currentHash !== record.sourceHash && record.kind !== "apply" && record.kind !== "rollback") {
        throw new BrokerError("SOURCE_CHANGED", "project changed after preview; live project was not changed", 409);
      }
      const result = redactObject(await this.executeFrozen(project, record, remainingMs));
      await this.serialize(async () => {
        const current = await this.load(id);
        if (current.state !== "running" || current.attemptId !== attemptId) return;
        current.result = result;
        current.state = "executed";
        current.executedAt = this.now().toISOString();
        delete current.failure;
        delete current.failedAt;
        delete current.leaseOwner;
        delete current.leaseExpiresAt;
        await this.write(current);
        await this.audit.append({
          event: "approval.executed",
          approvalId: current.id,
          projectId: current.projectId,
          kind: current.kind,
          attemptIdHash: sha256(attemptId),
          resultHash: sha256(JSON.stringify(current.result)),
          resultBytes: Buffer.byteLength(JSON.stringify(current.result)),
        });
      });
    } catch (error) {
      record = await this.load(id).catch(() => record);
      if (record.state !== "running" || record.attemptId !== attemptId) return;
      const failedStageId = stageIdFromError(error);
      if (failedStageId) {
        record.stageId = failedStageId;
        record.diagnosticStageId = failedStageId;
      }
      let finalError = error;
      let diagnosticPersisted = false;
      try {
        await this.persistWorkerFailure(record, error);
        diagnosticPersisted = true;
      } catch (failure) {
        finalError = failure;
      }
      if (diagnosticPersisted && project && record.kind === "develop" && record.stageId) {
        try {
          await discardStageForRecovery(this.options, project, record.stageId);
        } catch (cleanupError) {
          finalError = new BrokerError(
            "STAGE_CLEANUP_FAILED",
            cleanupError instanceof Error ? cleanupError.message : "failed stage cleanup failed",
            500,
          );
        }
      }
      await this.serialize(async () => {
        const current = await this.load(id);
        if (current.state !== "running" || current.attemptId !== attemptId) return;
        if (record.stageId) current.stageId = record.stageId;
        if (record.diagnosticStageId) current.diagnosticStageId = record.diagnosticStageId;
        current.state = "failed";
        current.failedAt = this.now().toISOString();
        current.failure = redactDiagnosticText(
          finalError instanceof Error ? finalError.message : "unknown execution failure",
          current.requestBody,
          500,
        );
        delete current.leaseOwner;
        delete current.leaseExpiresAt;
        await this.write(current);
        await this.audit.append({
          event: "approval.failed",
          approvalId: current.id,
          projectId: current.projectId,
          kind: current.kind,
          attemptIdHash: sha256(attemptId),
          errorCode: finalError instanceof BrokerError ? finalError.code : "UNEXPECTED_FAILURE",
        });
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private remainingExecutionMs(record: ApprovalRecord): number {
    const remaining = Date.parse(record.executionDeadlineAt ?? "") - this.now().getTime();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw new BrokerError("EXECUTION_TIMEOUT", "approval execution exceeded its total timeout", 504);
    }
    return remaining;
  }

  private failureStage(record: ApprovalRecord): StageManifest {
    const id = assertSafeIdentifier(
      record.diagnosticStageId ?? record.stageId ?? record.attemptId ?? "",
      "stageId",
    );
    return {
      schemaVersion: 1,
      id,
      projectId: record.projectId,
      sourceHash: record.sourceHash,
      requestHash: record.requestHash,
      createdAt: record.startedAt ?? this.now().toISOString(),
      mode: "isolated-git",
      path: path.join(this.options.dataDir, "staging", id),
      codex: { attempted: true, ok: false },
    };
  }

  private sandboxStageFor(error: unknown): SandboxStage {
    if (error instanceof ApplyValidationError) return "apply-validation";
    if (error instanceof BrokerError) {
      if (error.code === "SOURCE_CHANGED") return "source-validation";
      if (error.code === "EXECUTION_TIMEOUT") return "execution-timeout";
      if (error.code === "BROKER_RECOVERY_FAILED") return "broker-recovery";
      if (error.code === "DIAGNOSTIC_PERSISTENCE_FAILED") return "result-persistence";
    }
    return "task-execution";
  }

  private async persistWorkerFailure(record: ApprovalRecord, error: unknown): Promise<void> {
    if (error instanceof ApplyValidationError) {
      await persistApplyValidationFailure(this.options, record.id, record.requestBody, error);
      return;
    }
    await persistStageFailure(this.options, this.failureStage(record), record.id, record.requestBody, {
      sandboxStage: this.sandboxStageFor(error),
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : "unknown execution failure",
      outputTruncated: false,
    });
  }

  private async touchLease(id: string, attemptId: string): Promise<void> {
    await this.serialize(async () => {
      const record = await this.load(id);
      if (record.state !== "running" || record.attemptId !== attemptId) return;
      const now = this.now();
      record.heartbeatAt = now.toISOString();
      record.leaseOwner = this.#instanceId;
      record.leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs()).toISOString();
      await this.write(record);
    });
  }

  private async recoverRunning(id: string, reason: "broker-restart" | "orphan-recovery"): Promise<void> {
    const record = await this.serialize(async () => {
      const current = await this.load(id);
      if (current.state !== "running") return null;
      if (this.#active.has(id)) return null;
      const now = this.now();
      if (
        current.leaseOwner === this.#instanceId
        && Number.isFinite(Date.parse(current.leaseExpiresAt ?? ""))
        && Date.parse(current.leaseExpiresAt!) > now.getTime()
      ) {
        return null;
      }
      const attemptId = randomUUID();
      current.attemptId = attemptId;
      current.heartbeatAt = now.toISOString();
      current.executionDeadlineAt = current.executionDeadlineAt
        ?? new Date(now.getTime() + this.executionTimeoutMs()).toISOString();
      current.leaseOwner = this.#instanceId;
      current.leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs()).toISOString();
      current.recoveryCount = (current.recoveryCount ?? 0) + 1;
      current.diagnosticStageId = ["develop", "apply"].includes(current.kind)
        ? (current.stageId ?? randomUUID())
        : randomUUID();
      if (current.kind === "develop") current.stageId = current.diagnosticStageId;
      await this.write(current);
      await this.audit.append({
        event: "approval.recovered",
        approvalId: current.id,
        projectId: current.projectId,
        kind: current.kind,
        attemptIdHash: sha256(attemptId),
        reason,
        recoveryCount: current.recoveryCount,
      });
      return current;
    });
    if (record) this.launch(record.id, record.attemptId!, true);
  }

  private async sweepOrphans(): Promise<void> {
    const files = await readdir(this.approvalsDir()).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      const record = await this.load(id).catch(() => null);
      if (!record || this.#active.has(id)) continue;
      if (record.state === "allowed") {
        await this.beginExecution(id, undefined, "orphan-recovery").catch((error) => this.auditWorkerError(id, error));
        continue;
      }
      if (
        record.state === "running"
        && (!record.leaseExpiresAt || Date.parse(record.leaseExpiresAt) <= this.now().getTime())
      ) {
        await this.recoverRunning(id, "orphan-recovery");
      }
    }
  }

  private async auditWorkerError(id: string, error: unknown): Promise<void> {
    await this.audit.append({
      event: "approval.worker_error",
      approvalId: id,
      code: error instanceof BrokerError ? error.code : "UNEXPECTED_FAILURE",
    }).catch(() => undefined);
  }

  private async executeFrozen(project: ProjectConfig, record: ApprovalRecord, timeoutMs: number): Promise<unknown> {
    if (["start", "stop", "restart"].includes(record.kind)) {
      const commands = project.actions[record.kind as keyof ProjectConfig["actions"]];
      if (!commands?.length) throw new BrokerError("RECIPE_MISSING", "fixed action recipe disappeared", 409);
      const results = [];
      for (const argv of commands) {
        const result = await runCommand(argv, {
          timeoutMs: Math.min(120_000, timeoutMs),
          maxOutputBytes: this.options.maxOutputBytes,
        });
        results.push({ ...result, argv });
        if (result.code !== 0 || result.timedOut) throw new BrokerError("ACTION_FAILED", `${record.kind} failed`, 409);
      }
      return { action: record.kind, results };
    }
    if (record.kind === "develop") {
      if (!record.stageId) throw new BrokerError("STAGE_REQUIRED", "running development approval lost stageId");
      return await createStage(
        this.options,
        project,
        record.id,
        record.sourceHash,
        record.requestBody,
        record.stageId,
        timeoutMs,
      );
    }
    if (record.kind === "apply") {
      if (!record.stageId) throw new BrokerError("STAGE_REQUIRED", "frozen approval lost stageId");
      return await applyStage(this.options, project, record.stageId, record.id);
    }
    if (record.kind === "rollback") {
      if (!record.snapshotId) throw new BrokerError("SNAPSHOT_REQUIRED", "frozen approval lost snapshotId");
      return await applyRollback(this.options, project, record.snapshotId, record.id);
    }
    throw new BrokerError("ACTION_NOT_ALLOWED", "unregistered action is denied", 403);
  }
}
