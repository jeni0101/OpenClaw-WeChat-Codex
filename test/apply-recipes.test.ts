import { describe, expect, it } from "vitest";
import {
  legacyValidationRecipeHash,
  recipeConfigHash,
  resolveBindingRecipe,
  selectApplyRecipe,
} from "../src/ops/apply-recipes.js";
import type { ApplyRecipe } from "../src/ops/types.js";

function recipe(id: string, allowedPaths: string[]): ApplyRecipe {
  const withoutHash: Omit<ApplyRecipe, "configHash"> = {
    id,
    version: 1,
    registryVersion: 2,
    allowedPaths,
    stageSetup: [],
    verify: [["/usr/bin/npm", "--prefix", "frontend", "run", "lint"]],
    stageSetupProfiles: [],
    validationProfiles: ["s1-04b1-lint@1"],
    uid: 1000,
    gid: 1001,
  };
  return { ...withoutHash, configHash: recipeConfigHash(withoutHash) };
}

const b1 = recipe("s1-04b1", ["frontend/tests/Work.test.tsx"]);
const b2 = recipe("s1-04b2-1", [
  "backend/alembic/versions/0011_decisions_facts_risks.py",
  "backend/tests/database/test_migrations.py",
  "docs/17-s1-04b2-decisions-facts-risks.md",
]);

describe("versioned apply recipe selection", () => {
  it("selects exactly one recipe by exact changed-path set", () => {
    expect(selectApplyRecipe([b1, b2], [...b2.allowedPaths].reverse())).toBe(b2);
  });

  it("fails closed for zero and multiple matches", () => {
    expect(() => selectApplyRecipe([b1, b2], ["README.md"])).toThrow(/do not match any/);
    expect(() => selectApplyRecipe(
      [b1, recipe("duplicate", [...b1.allowedPaths])],
      b1.allowedPaths,
    )).toThrow(/more than one/);
  });

  it("rejects subset, superset, duplicate and traversal paths", () => {
    expect(() => selectApplyRecipe([b2], b2.allowedPaths.slice(0, 2))).toThrow(/do not match any/);
    expect(() => selectApplyRecipe([b2], [...b2.allowedPaths, "README.md"])).toThrow(/do not match any/);
    expect(() => selectApplyRecipe([b1], [...b1.allowedPaths, ...b1.allowedPaths])).toThrow(/duplicate/);
    expect(() => selectApplyRecipe([b1], ["../frontend/tests/Work.test.tsx"])).toThrow(/invalid/);
    expect(() => selectApplyRecipe([b1], ["/frontend/tests/Work.test.tsx"])).toThrow(/invalid/);
    expect(() => selectApplyRecipe([b1], ["frontend\\tests\\Work.test.tsx"])).toThrow(/invalid/);
  });
});

describe("apply binding compatibility", () => {
  it("reads schema 1 only for controlled rebind", () => {
    expect(resolveBindingRecipe([b1, b2], {
      schemaVersion: 1,
      allowedPaths: b1.allowedPaths,
    }, true)).toBe(b1);
    expect(() => resolveBindingRecipe([b1, b2], {
      schemaVersion: 1,
      allowedPaths: b1.allowedPaths,
    }, false)).toThrow(/must be rebound/);
  });

  it("resolves schema 2 by legacy hash and exact paths", () => {
    const hash = legacyValidationRecipeHash(b1);
    expect(resolveBindingRecipe([b1, b2], {
      schemaVersion: 2,
      allowedPaths: b1.allowedPaths,
      validationRecipeHash: hash,
    }, false)).toBe(b1);
    expect(() => resolveBindingRecipe([b1, b2], {
      schemaVersion: 2,
      allowedPaths: b2.allowedPaths,
      validationRecipeHash: hash,
    }, false)).toThrow(/not present/);
  });

  it("resolves schema 3 only by id, version, hash and paths", () => {
    expect(resolveBindingRecipe([b1, b2], {
      schemaVersion: 3,
      allowedPaths: b2.allowedPaths,
      recipeId: b2.id,
      recipeVersion: b2.version,
      recipeConfigHash: b2.configHash,
    }, false)).toBe(b2);
    for (const reference of [
      {
        schemaVersion: 3 as const,
        allowedPaths: b2.allowedPaths,
        recipeId: "wrong",
        recipeVersion: b2.version,
        recipeConfigHash: b2.configHash,
      },
      {
        schemaVersion: 3 as const,
        allowedPaths: b2.allowedPaths,
        recipeId: b2.id,
        recipeVersion: 2,
        recipeConfigHash: b2.configHash,
      },
      {
        schemaVersion: 3 as const,
        allowedPaths: b2.allowedPaths,
        recipeId: b2.id,
        recipeVersion: b2.version,
        recipeConfigHash: "0".repeat(64),
      },
      {
        schemaVersion: 3 as const,
        allowedPaths: b1.allowedPaths,
        recipeId: b2.id,
        recipeVersion: b2.version,
        recipeConfigHash: b2.configHash,
      },
    ]) {
      expect(() => resolveBindingRecipe([b1, b2], reference, false)).toThrow(/not present/);
    }
  });

  it("preserves the production B1 legacy hash byte-for-byte", () => {
    const withoutHash: Omit<ApplyRecipe, "configHash"> = {
      id: "s1-04b1",
      version: 1,
      registryVersion: 2,
      allowedPaths: ["frontend/tests/Work.test.tsx"],
      stageSetup: [[
        "/usr/bin/npm", "--prefix", "frontend", "ci", "--ignore-scripts",
        "--offline", "--no-audit", "--no-fund",
      ]],
      verify: [
        [
          "/usr/bin/npm", "--prefix", "frontend", "test", "--", "--run",
          "tests/Work.test.tsx", "--configLoader", "runner",
        ],
        ["/usr/bin/npm", "--prefix", "frontend", "run", "typecheck"],
        ["/usr/bin/npm", "--prefix", "frontend", "run", "lint"],
      ],
      stageSetupProfiles: ["s1-04b1-frontend-npm-ci@1"],
      validationProfiles: [
        "s1-04b1-work-test@1",
        "s1-04b1-typecheck@1",
        "s1-04b1-lint@1",
      ],
      uid: 1000,
      gid: 1001,
    };
    expect(legacyValidationRecipeHash({
      ...withoutHash,
      configHash: recipeConfigHash(withoutHash),
    })).toBe("451f8307873e1d09027ef82ada697f959476c701c3c2e3b1b5d897a7a0d59ae6");
  });
});
