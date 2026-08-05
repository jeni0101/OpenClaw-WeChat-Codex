import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface RegisteredCommand {
  name: string;
  requireAuth?: boolean;
  channels?: string[];
  requiredScopes?: string[];
  exposeSenderIsOwner?: boolean;
}

interface PluginEntry {
  register(api: {
    registerTool(factory: unknown, options: { name: string }): void;
    registerCommand(command: RegisteredCommand): void;
  }): void;
}

async function loadEntry(entryPath: string): Promise<PluginEntry> {
  const module = await import(pathToFileURL(entryPath).href);
  return module.default as PluginEntry;
}

function captureApproveCommand(entry: PluginEntry): RegisteredCommand {
  const commands: RegisteredCommand[] = [];
  entry.register({
    registerTool() {},
    registerCommand(command) {
      commands.push(command);
    },
  });
  const approve = commands.find((command) => command.name === "approve");
  if (!approve) throw new Error("project-ops did not register /approve");
  return approve;
}

function captureToolNames(entry: PluginEntry): string[] {
  const tools: string[] = [];
  entry.register({
    registerTool(_factory, options) {
      tools.push(options.name);
    },
    registerCommand() {},
  });
  return tools;
}

function securityDeclaration(command: RegisteredCommand) {
  return {
    requireAuth: command.requireAuth,
    channels: command.channels,
    requiredScopes: command.requiredScopes,
    exposeSenderIsOwner: command.exposeSenderIsOwner,
  };
}

describe("project-ops published runtime entry", () => {
  it("loads the real openclaw.extensions dist entry and matches the source security declaration", async () => {
    const root = process.cwd();
    const pluginRoot = path.join(root, "plugins/project-ops");
    const rootPackageJson = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const packageJson = JSON.parse(
      await readFile(path.join(pluginRoot, "package.json"), "utf8"),
    ) as { openclaw?: { extensions?: string[] } };
    const manifest = JSON.parse(
      await readFile(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
    ) as { contracts?: { tools?: string[] } };
    const runtimeEntry = packageJson.openclaw?.extensions?.[0];
    const pluginBuild = rootPackageJson.scripts?.["build:plugins"] ?? "";

    expect(runtimeEntry).toBe("./dist/index.js");
    expect(pluginBuild).toContain("tsc -p plugins/project-ops/tsconfig.json");
    expect(pluginBuild).not.toMatch(
      /tsc -p plugins\/project-ops\/tsconfig\.json\s+--noEmit/,
    );

    const distEntry = await loadEntry(path.resolve(pluginRoot, runtimeEntry!));
    const sourceEntry = await loadEntry(path.join(pluginRoot, "src/index.ts"));
    const distCommand = captureApproveCommand(distEntry);
    const sourceCommand = captureApproveCommand(sourceEntry);

    expect(securityDeclaration(distCommand)).toEqual(securityDeclaration(sourceCommand));
    expect(securityDeclaration(distCommand)).toEqual({
      requireAuth: true,
      channels: ["openclaw-weixin"],
      requiredScopes: ["operator.approvals"],
      exposeSenderIsOwner: undefined,
    });
    expect(captureToolNames(distEntry)).toEqual(captureToolNames(sourceEntry));
    expect(captureToolNames(distEntry)).toContain("project_change_result");
    expect(manifest.contracts?.tools).toEqual(captureToolNames(distEntry));
  });
});
