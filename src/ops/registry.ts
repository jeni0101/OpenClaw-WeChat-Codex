import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { normalizePathSet, recipeConfigHash } from "./apply-recipes.js";
import { BrokerError } from "./errors.js";
import { expandApplyProfiles, isApplyProfileId } from "./validation-profiles.js";
import type {
  ApplyProfileId,
  ApplyRecipe,
  ProjectConfig,
  RegistryConfig,
  SourceMode,
  StatusCheck,
  UnavailableProject,
} from "./types.js";

const ALLOWED_EXECUTABLES = new Set([
  "/usr/bin/docker",
  "/usr/bin/npm",
  "/usr/bin/python3",
  "/usr/bin/systemctl",
]);
const ACTIONS = new Set(["start", "stop", "restart"]);
const SOURCE_MODES = new Set<SourceMode>(["clean-git", "dirty-git", "snapshot"]);

function validateArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || value.some((v) => typeof v !== "string")) {
    throw new BrokerError("INVALID_REGISTRY", "command must be a string argv array");
  }
  const argv = value as string[];
  if (!ALLOWED_EXECUTABLES.has(argv[0]!)) {
    throw new BrokerError("INVALID_REGISTRY", `executable is not allowed: ${argv[0]}`);
  }
  if (argv.some((item) => item.includes("\u0000") || item.length > 1024)) {
    throw new BrokerError("INVALID_REGISTRY", "command contains an invalid argument");
  }
  return [...argv];
}

function validateApplyArgv(value: unknown): string[] {
  const argv = validateArgv(value);
  if (argv[0] !== "/usr/bin/npm") return argv;
  let verb: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--prefix") {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    verb = argument;
    break;
  }
  if (!verb || !["ci", "test", "run"].includes(verb)) {
    throw new BrokerError(
      "INVALID_REGISTRY",
      "apply npm commands must use an explicit ci, test, or run verb",
    );
  }
  return argv;
}

function validateChecks(value: unknown): StatusCheck[] {
  if (!Array.isArray(value)) throw new BrokerError("INVALID_REGISTRY", "status must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new BrokerError("INVALID_REGISTRY", "status entry is invalid");
    const obj = entry as Record<string, unknown>;
    if (typeof obj.name !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(obj.name)) {
      throw new BrokerError("INVALID_REGISTRY", "status check name is invalid");
    }
    const timeoutMs = obj.timeoutMs === undefined ? undefined : Number(obj.timeoutMs);
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000)) {
      throw new BrokerError("INVALID_REGISTRY", "status timeout is invalid");
    }
    return { name: obj.name, argv: validateArgv(obj.argv), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  });
}

function validateLegacyApplyRecipe(value: unknown, projectId: string): ApplyRecipe | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply recipe is invalid`);
  }
  const recipe = value as Record<string, unknown>;
  if (
    !Array.isArray(recipe.allowedPaths)
    || recipe.allowedPaths.length < 1
    || recipe.allowedPaths.length > 16
    || recipe.allowedPaths.some((entry) => typeof entry !== "string")
  ) {
    throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply allowedPaths are invalid`);
  }
  try {
    normalizePathSet(recipe.allowedPaths as string[], `${projectId} allowedPaths`);
  } catch {
    throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply allowedPaths are invalid`);
  }
  if (!Array.isArray(recipe.verify) || recipe.verify.length < 1 || recipe.verify.length > 8) {
    throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply verify commands are invalid`);
  }
  const stageSetup = recipe.stageSetup ?? [];
  if (!Array.isArray(stageSetup) || stageSetup.length > 4) {
    throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply stage setup commands are invalid`);
  }
  const uid = Number(recipe.uid);
  const gid = Number(recipe.gid);
  if (
    !Number.isSafeInteger(uid)
    || !Number.isSafeInteger(gid)
    || uid < 1
    || gid < 1
    || uid > 2 ** 31 - 1
    || gid > 2 ** 31 - 1
  ) {
    throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply uid/gid are invalid`);
  }
  const withoutHash: Omit<ApplyRecipe, "configHash"> = {
    id: "legacy-default",
    version: 1,
    registryVersion: 1,
    allowedPaths: [...recipe.allowedPaths] as string[],
    stageSetup: stageSetup.map(validateApplyArgv),
    verify: recipe.verify.map(validateApplyArgv),
    stageSetupProfiles: null,
    validationProfiles: null,
    uid,
    gid,
  };
  return { ...withoutHash, configHash: recipeConfigHash(withoutHash) };
}

function validateProfileIds(
  value: unknown,
  projectId: string,
  field: string,
  min: number,
  max: number,
): ApplyProfileId[] {
  if (
    !Array.isArray(value)
    || value.length < min
    || value.length > max
    || value.some((entry) => !isApplyProfileId(entry))
  ) {
    throw new BrokerError("INVALID_REGISTRY", `${projectId}: ${field} profiles are invalid`);
  }
  return [...value] as ApplyProfileId[];
}

function validateVersionedApplyRecipes(value: unknown, projectId: string): ApplyRecipe[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("INVALID_REGISTRY", `${projectId}: versioned apply catalog is invalid`);
  }
  const catalog = value as Record<string, unknown>;
  if (
    catalog.selection !== "exact-changed-paths"
    || !Array.isArray(catalog.recipes)
    || catalog.recipes.length < 1
    || catalog.recipes.length > 16
  ) {
    throw new BrokerError("INVALID_REGISTRY", `${projectId}: versioned apply catalog is invalid`);
  }
  const catalogKeys = Object.keys(catalog).sort();
  if (JSON.stringify(catalogKeys) !== JSON.stringify(["recipes", "selection"])) {
    throw new BrokerError("INVALID_REGISTRY", `${projectId}: versioned apply catalog keys are invalid`);
  }
  const identities = new Set<string>();
  return catalog.recipes.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply recipe ${index} is invalid`);
    }
    const recipe = raw as Record<string, unknown>;
    const keys = Object.keys(recipe).sort();
    const expected = [
      "allowedPaths",
      "gid",
      "id",
      "stageSetupProfiles",
      "uid",
      "validationProfiles",
      "version",
    ];
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply recipe keys are invalid`);
    }
    if (typeof recipe.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(recipe.id)) {
      throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply recipe id is invalid`);
    }
    const version = Number(recipe.version);
    if (!Number.isSafeInteger(version) || version < 1 || version > 2 ** 31 - 1) {
      throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply recipe version is invalid`);
    }
    const identity = `${recipe.id}@${version}`;
    if (identities.has(identity)) {
      throw new BrokerError("INVALID_REGISTRY", `${projectId}: duplicate apply recipe identity`);
    }
    identities.add(identity);
    if (!Array.isArray(recipe.allowedPaths) || recipe.allowedPaths.some((entry) => typeof entry !== "string")) {
      throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply allowedPaths are invalid`);
    }
    let allowedPaths: string[];
    try {
      allowedPaths = normalizePathSet(recipe.allowedPaths as string[], `${identity} allowedPaths`);
    } catch {
      throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply allowedPaths are invalid`);
    }
    const stageSetupProfiles = validateProfileIds(
      recipe.stageSetupProfiles,
      projectId,
      "stage setup",
      0,
      4,
    );
    const validationProfiles = validateProfileIds(
      recipe.validationProfiles,
      projectId,
      "validation",
      1,
      8,
    );
    const uid = Number(recipe.uid);
    const gid = Number(recipe.gid);
    if (
      !Number.isSafeInteger(uid)
      || !Number.isSafeInteger(gid)
      || uid < 1
      || gid < 1
      || uid > 2 ** 31 - 1
      || gid > 2 ** 31 - 1
    ) {
      throw new BrokerError("INVALID_REGISTRY", `${projectId}: apply uid/gid are invalid`);
    }
    const stageSetup = expandApplyProfiles(stageSetupProfiles, "stage-setup");
    const verify = expandApplyProfiles(validationProfiles, "validation");
    const withoutHash: Omit<ApplyRecipe, "configHash"> = {
      id: recipe.id,
      version,
      registryVersion: 2,
      allowedPaths,
      stageSetup,
      verify,
      stageSetupProfiles,
      validationProfiles,
      uid,
      gid,
    };
    return { ...withoutHash, configHash: recipeConfigHash(withoutHash) };
  });
}

export async function loadRegistry(registryPath: string): Promise<RegistryConfig> {
  const parsed = YAML.parse(await readFile(registryPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") throw new BrokerError("INVALID_REGISTRY", "registry root is invalid");
  const root = parsed as Record<string, unknown>;
  if (![1, 2].includes(Number(root.version)) || !root.projects || typeof root.projects !== "object") {
    throw new BrokerError("INVALID_REGISTRY", "registry version or projects is invalid");
  }
  const registryVersion = Number(root.version) as 1 | 2;

  const projects = new Map<string, ProjectConfig>();
  const unavailableProjects = new Map<string, UnavailableProject>();
  for (const [id, raw] of Object.entries(root.projects as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !raw || typeof raw !== "object") {
      throw new BrokerError("INVALID_REGISTRY", `invalid project entry: ${id}`);
    }
    const value = raw as Record<string, unknown>;
    if (typeof value.path !== "string" || !path.isAbsolute(value.path)) {
      throw new BrokerError("INVALID_REGISTRY", `${id}: project path must be absolute`);
    }
    if (!SOURCE_MODES.has(value.sourceMode as SourceMode)) {
      throw new BrokerError("INVALID_REGISTRY", `${id}: sourceMode is invalid`);
    }
    if (!Array.isArray(value.capabilities) || value.capabilities.some((c) => typeof c !== "string")) {
      throw new BrokerError("INVALID_REGISTRY", `${id}: capabilities are invalid`);
    }
    const actions: ProjectConfig["actions"] = {};
    if (!value.actions || typeof value.actions !== "object") throw new BrokerError("INVALID_REGISTRY", `${id}: actions are invalid`);
    for (const [action, commands] of Object.entries(value.actions as Record<string, unknown>)) {
      if (!ACTIONS.has(action) || !Array.isArray(commands)) throw new BrokerError("INVALID_REGISTRY", `${id}: action is invalid`);
      actions[action as keyof ProjectConfig["actions"]] = commands.map(validateArgv);
    }
    const status = validateChecks(value.status);
    const test = value.test === undefined ? undefined : validateArgv(value.test);
    const applyRecipes = registryVersion === 1
      ? [validateLegacyApplyRecipe(value.apply, id)].filter(
          (recipe): recipe is ApplyRecipe => recipe !== undefined,
        )
      : value.apply === undefined
        ? []
        : validateVersionedApplyRecipes(value.apply, id);
    if (value.capabilities.includes("apply") && (applyRecipes.length === 0 || value.sourceMode !== "clean-git")) {
      throw new BrokerError("INVALID_REGISTRY", `${id}: apply capability requires a clean-git fixed apply recipe`);
    }
    const info = await stat(value.path).catch(() => null);
    if (!info?.isDirectory()) {
      unavailableProjects.set(id, {
        id,
        code: "PROJECT_DIRECTORY_MISSING",
        message: `${id}: project directory does not exist`,
      });
      continue;
    }
    const realPath = await realpath(value.path);
    projects.set(id, {
      id,
      path: value.path,
      realPath,
      sourceMode: value.sourceMode as SourceMode,
      description: typeof value.description === "string" ? value.description : "",
      capabilities: [...value.capabilities] as string[],
      status,
      actions,
      ...(test === undefined ? {} : { test }),
      ...(applyRecipes.length === 0 ? {} : { applyRecipes }),
      ...(applyRecipes.length === 1 ? { applyRecipe: applyRecipes[0]! } : {}),
    });
  }
  return { version: registryVersion, projects, unavailableProjects };
}

export function getProject(registry: RegistryConfig, id: string): ProjectConfig {
  const project = registry.projects.get(id);
  const unavailable = registry.unavailableProjects.get(id);
  if (unavailable) throw new BrokerError("PROJECT_UNAVAILABLE", unavailable.message, 409);
  if (!project) throw new BrokerError("PROJECT_NOT_ALLOWED", "project is not in the allowlist", 404);
  return project;
}

export function assertCapability(project: ProjectConfig, capability: string): void {
  if (!project.capabilities.includes(capability)) {
    throw new BrokerError("ACTION_NOT_ALLOWED", `${capability} is not allowed for ${project.id}`, 403);
  }
}
