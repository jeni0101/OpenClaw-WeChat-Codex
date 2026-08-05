import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_BY_PLATFORM: Record<string, string> = {
  "linux-x64": "codex-linux-x64",
  "linux-arm64": "codex-linux-arm64",
  "darwin-x64": "codex-darwin-x64",
  "darwin-arm64": "codex-darwin-arm64",
  "win32-x64": "codex-win32-x64",
  "win32-arm64": "codex-win32-arm64",
};

export async function pruneCodexPlatformPackages(projectRoot = "/opt/WeChat-Open in"): Promise<string[]> {
  const keep = PACKAGE_BY_PLATFORM[`${process.platform}-${process.arch}`];
  if (!keep) throw new Error(`unsupported platform for Codex pruning: ${process.platform}-${process.arch}`);
  const vendorRoot = path.join(projectRoot, "node_modules", "@openclaw", "codex", "node_modules", "@openai");
  const info = await stat(vendorRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("@openclaw/codex platform package directory is missing");
  const removed: string[] = [];
  for (const packageName of Object.values(PACKAGE_BY_PLATFORM)) {
    if (packageName === keep) continue;
    const target = path.join(vendorRoot, packageName);
    if (await stat(target).catch(() => null)) {
      await rm(target, { recursive: true, force: true });
      removed.push(packageName);
    }
  }
  return removed;
}

export async function pruneAllCodexPlatformPackages(projectRoot = "/opt/WeChat-Open in"): Promise<Record<string, string[]>> {
  const roots = [projectRoot];
  const managedRoot = path.join(projectRoot, "data", "state", "npm", "projects");
  for (const entry of await readdir(managedRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && /^openclaw-codex-[a-f0-9]+$/.test(entry.name)) roots.push(path.join(managedRoot, entry.name));
  }
  const output: Record<string, string[]> = {};
  for (const root of roots) {
    const vendorRoot = path.join(root, "node_modules", "@openclaw", "codex", "node_modules", "@openai");
    if (await stat(vendorRoot).catch(() => null)) output[root] = await pruneCodexPlatformPackages(root);
  }
  if (Object.keys(output).length === 0) throw new Error("no Codex plugin installations were found");
  return output;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  pruneAllCodexPlatformPackages().then((removed) => {
    process.stdout.write(`${JSON.stringify({ ok: true, platform: `${process.platform}-${process.arch}`, removed })}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
    process.exitCode = 1;
  });
}
