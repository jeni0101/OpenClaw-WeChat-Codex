import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { legacyValidationRecipeHash } from "../src/ops/apply-recipes.js";
import { loadRegistry } from "../src/ops/registry.js";

const roots: string[] = [];

async function fixture(yaml: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "registry-recipe-test-"));
  roots.push(root);
  await mkdir(path.join(root, "project"));
  const registry = path.join(root, "projects.yaml");
  await writeFile(
    registry,
    yaml.replaceAll("__PROJECT__", JSON.stringify(path.join(root, "project"))),
  );
  return registry;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("registry apply recipe schemas", () => {
  it("loads registry v1 without changing its legacy hash", async () => {
    const registry = await loadRegistry(await fixture([
      "version: 1",
      "projects:",
      "  demo:",
      "    path: __PROJECT__",
      "    sourceMode: clean-git",
      "    capabilities: [apply]",
      "    status: []",
      "    actions: {}",
      "    apply:",
      "      allowedPaths: [frontend/tests/Work.test.tsx]",
      "      stageSetup:",
      "        - [/usr/bin/npm, --prefix, frontend, ci, --ignore-scripts, --offline, --no-audit, --no-fund]",
      "      verify:",
      "        - [/usr/bin/npm, --prefix, frontend, test, --, --run, tests/Work.test.tsx, --configLoader, runner]",
      "        - [/usr/bin/npm, --prefix, frontend, run, typecheck]",
      "        - [/usr/bin/npm, --prefix, frontend, run, lint]",
      "      uid: 1000",
      "      gid: 1001",
      "",
    ].join("\n")));
    const recipe = registry.projects.get("demo")!.applyRecipe!;
    expect(registry.version).toBe(1);
    expect(recipe.registryVersion).toBe(1);
    expect(legacyValidationRecipeHash(recipe)).toBe(
      "451f8307873e1d09027ef82ada697f959476c701c3c2e3b1b5d897a7a0d59ae6",
    );
  });

  it("loads registry v2 with B1 and B2 fixed profiles only", async () => {
    const registry = await loadRegistry(await fixture([
      "version: 2",
      "projects:",
      "  demo:",
      "    path: __PROJECT__",
      "    sourceMode: clean-git",
      "    capabilities: [apply]",
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
      "          uid: 1000",
      "          gid: 1001",
      "        - id: s1-04b2-1",
      "          version: 1",
      "          allowedPaths:",
      "            - backend/alembic/versions/0011_decisions_facts_risks.py",
      "            - backend/tests/database/test_migrations.py",
      "            - docs/17-s1-04b2-decisions-facts-risks.md",
      "          stageSetupProfiles: []",
      "          validationProfiles:",
      "            - s1-04b2-1-db-check@1",
      "            - s1-04b2-1-ruff-check@1",
      "            - s1-04b2-1-ruff-format@1",
      "            - s1-04b2-1-mypy@1",
      "          uid: 1000",
      "          gid: 1001",
      "        - id: s1-04b2-2",
      "          version: 1",
      "          allowedPaths:",
      "            - backend/app/api/v1/knowledge.py",
      "            - backend/app/schemas/knowledge.py",
      "            - backend/app/services/knowledge.py",
      "            - backend/tests/database/test_decisions_facts_risks.py",
      "            - backend/tests/unit/test_knowledge_helpers.py",
      "            - docs/03-api.md",
      "            - docs/11-requirements-traceability.md",
      "            - docs/17-s1-04b2-decisions-facts-risks.md",
      "          stageSetupProfiles: []",
      "          validationProfiles:",
      "            - s1-04b2-1-db-check@1",
      "            - s1-04b2-1-ruff-check@1",
      "            - s1-04b2-1-ruff-format@1",
      "            - s1-04b2-1-mypy@1",
      "          uid: 1000",
      "          gid: 1001",
      "",
    ].join("\n")));
    const recipes = registry.projects.get("demo")!.applyRecipes!;
    expect(registry.version).toBe(2);
    expect(recipes.map((recipe) => `${recipe.id}@${recipe.version}`)).toEqual([
      "s1-04b1@1",
      "s1-04b2-1@1",
      "s1-04b2-2@1",
    ]);
    expect(recipes[0]!.stageSetup).toEqual([[
      "/usr/bin/npm", "--prefix", "frontend", "ci", "--ignore-scripts",
      "--offline", "--no-audit", "--no-fund",
    ]]);
    expect(recipes[1]!.verify).toHaveLength(4);
    expect(recipes[2]!.verify).toEqual(recipes[1]!.verify);
    expect(registry.projects.get("demo")!.applyRecipe).toBeUndefined();
  });

  it("rejects arbitrary argv, env and cwd in registry v2", async () => {
    for (const injected of [
      "          argv: [/bin/sh, -c, id]",
      "          env: {TOKEN: value}",
      "          cwd: /tmp",
    ]) {
      await expect(loadRegistry(await fixture([
        "version: 2",
        "projects:",
        "  demo:",
        "    path: __PROJECT__",
        "    sourceMode: clean-git",
        "    capabilities: [apply]",
        "    status: []",
        "    actions: {}",
        "    apply:",
        "      selection: exact-changed-paths",
        "      recipes:",
        "        - id: s1-04b1",
        "          version: 1",
        "          allowedPaths: [frontend/tests/Work.test.tsx]",
        "          stageSetupProfiles: [s1-04b1-frontend-npm-ci@1]",
        "          validationProfiles: [s1-04b1-work-test@1]",
        "          uid: 1000",
        "          gid: 1001",
        injected,
        "",
      ].join("\n")))).rejects.toThrow(/keys are invalid|catalog/);
    }
  });

  it("rejects unknown or phase-incompatible profiles", async () => {
    const unknown = await fixture([
      "version: 2",
      "projects:",
      "  demo:",
      "    path: __PROJECT__",
      "    sourceMode: clean-git",
      "    capabilities: [apply]",
      "    status: []",
      "    actions: {}",
      "    apply:",
      "      selection: exact-changed-paths",
      "      recipes:",
      "        - id: s1-04b1",
      "          version: 1",
      "          allowedPaths: [frontend/tests/Work.test.tsx]",
      "          stageSetupProfiles: []",
      "          validationProfiles: [arbitrary@1]",
      "          uid: 1000",
      "          gid: 1001",
      "",
    ].join("\n"));
    await expect(loadRegistry(unknown)).rejects.toThrow(/profiles are invalid/);

    const incompatible = await fixture([
      "version: 2",
      "projects:",
      "  demo:",
      "    path: __PROJECT__",
      "    sourceMode: clean-git",
      "    capabilities: [apply]",
      "    status: []",
      "    actions: {}",
      "    apply:",
      "      selection: exact-changed-paths",
      "      recipes:",
      "        - id: s1-04b1",
      "          version: 1",
      "          allowedPaths: [frontend/tests/Work.test.tsx]",
      "          stageSetupProfiles: []",
      "          validationProfiles: [s1-04b1-frontend-npm-ci@1]",
      "          uid: 1000",
      "          gid: 1001",
      "",
    ].join("\n"));
    await expect(loadRegistry(incompatible)).rejects.toThrow(/cannot be used as a validation/);
  });
});
