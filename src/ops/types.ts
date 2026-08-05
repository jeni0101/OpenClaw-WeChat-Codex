export const CHANGE_KINDS = [
  "develop",
  "apply",
  "start",
  "stop",
  "restart",
  "deploy",
  "rollback",
] as const;

export const APPLY_PROFILE_IDS = [
  "s1-04b1-frontend-npm-ci@1",
  "s1-04b1-work-test@1",
  "s1-04b1-typecheck@1",
  "s1-04b1-lint@1",
  "s1-04b2-1-db-check@1",
  "s1-04b2-1-ruff-check@1",
  "s1-04b2-1-ruff-format@1",
  "s1-04b2-1-mypy@1",
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];
export type ApplyProfileId = (typeof APPLY_PROFILE_IDS)[number];
export type ApprovalDecision = "allow" | "deny";
export type ApprovalState = "pending" | "allowed" | "running" | "denied" | "executed" | "failed" | "expired";
export type SourceMode = "clean-git" | "dirty-git" | "snapshot";

export interface StatusCheck {
  name: string;
  argv: string[];
  timeoutMs?: number;
}

export interface ApplyRecipe {
  id: string;
  version: number;
  registryVersion: 1 | 2;
  configHash: string;
  allowedPaths: string[];
  stageSetup: string[][];
  verify: string[][];
  stageSetupProfiles: ApplyProfileId[] | null;
  validationProfiles: ApplyProfileId[] | null;
  uid: number;
  gid: number;
}

export interface ApplyBindingRecipeReference {
  schemaVersion: 1 | 2 | 3;
  allowedPaths: string[];
  validationRecipeHash?: string;
  recipeId?: string;
  recipeVersion?: number;
  recipeConfigHash?: string;
}

export interface ProjectConfig {
  id: string;
  path: string;
  realPath: string;
  sourceMode: SourceMode;
  description: string;
  capabilities: string[];
  status: StatusCheck[];
  actions: Partial<Record<"start" | "stop" | "restart", string[][]>>;
  test?: string[];
  applyRecipe?: ApplyRecipe;
  applyRecipes?: ApplyRecipe[];
}

export interface UnavailableProject {
  id: string;
  code: "PROJECT_DIRECTORY_MISSING";
  message: string;
}

export interface RegistryConfig {
  version: number;
  projects: Map<string, ProjectConfig>;
  unavailableProjects: Map<string, UnavailableProject>;
}

export interface Actor {
  senderId: string;
  channel: string;
  senderIsOwner: boolean;
}

export interface PrepareRequest {
  projectId: string;
  kind: ChangeKind;
  request: string;
  stageId?: string;
  snapshotId?: string;
  actor: Actor;
}

export interface ApprovalRecord {
  schemaVersion: 1;
  id: string;
  projectId: string;
  kind: ChangeKind;
  requestSummary: string;
  requestBody: string;
  requestHash: string;
  sourceHash: string;
  preview: unknown;
  stageId?: string;
  diagnosticStageId?: string;
  snapshotId?: string;
  ownerId: string;
  createdAt: string;
  expiresAt: string;
  state: ApprovalState;
  decisionAt?: string;
  startedAt?: string;
  heartbeatAt?: string;
  executionDeadlineAt?: string;
  attemptId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  recoveryCount?: number;
  executedAt?: string;
  failedAt?: string;
  failure?: string;
  result?: unknown;
}

export interface CommandResult {
  argv: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface BrokerOptions {
  socketPath: string;
  dataDir: string;
  registryPath: string;
  token: string;
  ownerId: string;
  maxOutputBytes: number;
  approvalTtlMs: number;
  executionTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
  orphanSweepIntervalMs?: number;
  codexExecutable?: string;
  codexRunner?: string;
  codexHome?: string;
  codexAgentDir?: string;
  codexConfigPath?: string;
  serviceUid?: number;
  serviceGid?: number;
  applyValidationTimeoutMs?: number;
  applyValidationMaxOutputBytes?: number;
  applyBundleDirectory?: string;
  now?: () => Date;
}
