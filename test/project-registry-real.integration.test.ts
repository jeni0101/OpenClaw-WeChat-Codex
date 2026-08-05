import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRegistry as loadSourceRegistry } from "../src/ops/registry.js";

interface DistRegistryModule {
  loadRegistry: typeof loadSourceRegistry;
}

describe("public example registry and dist", () => {
  it("loads the sanitized example consistently from source and dist", async () => {
    const root = process.cwd();
    const registryPath = path.join(root, "config", "projects.example.yaml");
    const distModule = await import(
      pathToFileURL(path.join(root, "dist", "src", "ops", "registry.js")).href
    ) as DistRegistryModule;
    const source = await loadSourceRegistry(registryPath);
    const compiled = await distModule.loadRegistry(registryPath);

    expect(source.version).toBe(2);
    expect([...source.projects.keys()]).toEqual([]);
    expect([...compiled.projects.keys()]).toEqual([]);
    expect(source.unavailableProjects.get("example")).toMatchObject({
      id: "example",
      code: "PROJECT_DIRECTORY_MISSING",
    });
    expect(source.unavailableProjects.get("example"))
      .toEqual(compiled.unavailableProjects.get("example"));
  });
});
