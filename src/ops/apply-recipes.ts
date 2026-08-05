import { BrokerError } from "./errors.js";
import { sha256 } from "./security.js";
import type {
  ApplyBindingRecipeReference,
  ApplyRecipe,
  ProjectConfig,
} from "./types.js";

const RECIPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;

export function normalizePathSet(paths: readonly string[], label: string): string[] {
  if (paths.length < 1 || paths.length > 16) {
    throw new BrokerError("INVALID_PATH_SET", `${label} must contain between 1 and 16 paths`, 409);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of paths) {
    if (
      typeof entry !== "string"
      || entry.length < 1
      || entry.length > 256
      || entry.startsWith("/")
      || entry.includes("\\")
      || entry.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new BrokerError("INVALID_PATH_SET", `${label} contains an invalid relative path`, 409);
    }
    if (seen.has(entry)) {
      throw new BrokerError("INVALID_PATH_SET", `${label} contains a duplicate path`, 409);
    }
    seen.add(entry);
    normalized.push(entry);
  }
  return normalized.sort();
}

export function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  try {
    return JSON.stringify(normalizePathSet(left, "left path set"))
      === JSON.stringify(normalizePathSet(right, "right path set"));
  } catch {
    return false;
  }
}

export function recipeConfigHash(recipe: Omit<ApplyRecipe, "configHash">): string {
  if (!RECIPE_ID.test(recipe.id)) {
    throw new BrokerError("INVALID_REGISTRY", "apply recipe id is invalid");
  }
  if (!Number.isSafeInteger(recipe.version) || recipe.version < 1 || recipe.version > 2 ** 31 - 1) {
    throw new BrokerError("INVALID_REGISTRY", "apply recipe version is invalid");
  }
  const allowedPaths = normalizePathSet(recipe.allowedPaths, `${recipe.id} allowedPaths`);
  if (recipe.registryVersion === 1) {
    return sha256(JSON.stringify({
      id: recipe.id,
      version: recipe.version,
      allowedPaths,
      stageSetup: recipe.stageSetup,
      verify: recipe.verify,
      uid: recipe.uid,
      gid: recipe.gid,
    }));
  }
  if (!recipe.stageSetupProfiles || !recipe.validationProfiles) {
    throw new BrokerError("INVALID_REGISTRY", `${recipe.id}: profile recipe is incomplete`);
  }
  return sha256(JSON.stringify({
    id: recipe.id,
    version: recipe.version,
    allowedPaths,
    stageSetupProfiles: recipe.stageSetupProfiles,
    validationProfiles: recipe.validationProfiles,
    uid: recipe.uid,
    gid: recipe.gid,
  }));
}

export function legacyValidationRecipeHash(recipe: ApplyRecipe): string {
  return sha256(JSON.stringify({
    allowedPaths: recipe.allowedPaths,
    stageSetup: recipe.stageSetup,
    verify: recipe.verify,
    uid: recipe.uid,
    gid: recipe.gid,
  }));
}

export function availableApplyRecipes(project: ProjectConfig): ApplyRecipe[] {
  if (project.applyRecipes?.length) return project.applyRecipes;
  if (project.applyRecipe) return [project.applyRecipe];
  return [];
}

export function selectApplyRecipe(
  recipes: readonly ApplyRecipe[],
  changedPaths: readonly string[],
): ApplyRecipe {
  const normalized = normalizePathSet(changedPaths, "stage changed paths");
  const matches = recipes.filter((recipe) => samePathSet(recipe.allowedPaths, normalized));
  if (matches.length === 0) {
    throw new BrokerError(
      "STAGE_SCOPE_VIOLATION",
      "stage changed paths do not match any fixed apply recipe",
      409,
    );
  }
  if (matches.length !== 1) {
    throw new BrokerError(
      "APPLY_RECIPE_AMBIGUOUS",
      "stage changed paths match more than one fixed apply recipe",
      409,
    );
  }
  return matches[0]!;
}

export function resolveBindingRecipe(
  recipes: readonly ApplyRecipe[],
  binding: ApplyBindingRecipeReference,
  allowSchema1: boolean,
): ApplyRecipe {
  const pathMatches = recipes.filter((recipe) => samePathSet(recipe.allowedPaths, binding.allowedPaths));
  let matches: ApplyRecipe[];
  if (binding.schemaVersion === 1) {
    if (!allowSchema1) {
      throw new BrokerError(
        "LEGACY_BINDING_REQUIRES_REBIND",
        "schema 1 apply binding must be rebound by a new owner approval",
        409,
      );
    }
    matches = pathMatches;
  } else if (binding.schemaVersion === 2) {
    if (!HASH.test(binding.validationRecipeHash ?? "")) {
      throw new BrokerError("STAGE_BINDING_CORRUPT", "schema 2 recipe hash is invalid", 409);
    }
    matches = pathMatches.filter(
      (recipe) => legacyValidationRecipeHash(recipe) === binding.validationRecipeHash,
    );
  } else {
    if (
      !RECIPE_ID.test(binding.recipeId ?? "")
      || !Number.isSafeInteger(binding.recipeVersion)
      || (binding.recipeVersion ?? 0) < 1
      || !HASH.test(binding.recipeConfigHash ?? "")
    ) {
      throw new BrokerError("STAGE_BINDING_CORRUPT", "schema 3 recipe reference is invalid", 409);
    }
    matches = pathMatches.filter((recipe) => (
      recipe.id === binding.recipeId
      && recipe.version === binding.recipeVersion
      && recipe.configHash === binding.recipeConfigHash
    ));
  }
  if (matches.length === 0) {
    throw new BrokerError(
      "APPLY_RECIPE_NOT_FOUND",
      "frozen apply recipe is not present in the current registry",
      409,
    );
  }
  if (matches.length !== 1) {
    throw new BrokerError(
      "APPLY_RECIPE_AMBIGUOUS",
      "frozen apply binding resolves to more than one recipe",
      409,
    );
  }
  return matches[0]!;
}

export function withApplyRecipe(project: ProjectConfig, recipe: ApplyRecipe): ProjectConfig {
  return {
    ...project,
    applyRecipe: recipe,
    applyRecipes: availableApplyRecipes(project),
  };
}
