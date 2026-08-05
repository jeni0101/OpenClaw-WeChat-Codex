import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { BrokerError } from "./errors.js";
import { isExcludedRelativePath } from "./security.js";
import type { ProjectConfig } from "./types.js";

const MAX_FILES = 50_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;

async function collectFiles(root: string, relative = "", output: string[] = []): Promise<string[]> {
  if (output.length > MAX_FILES) throw new BrokerError("SOURCE_TOO_LARGE", "source contains too many files");
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (isExcludedRelativePath(child)) continue;
    if (entry.isDirectory()) await collectFiles(root, child, output);
    else output.push(child);
  }
  return output;
}
async function hashFile(hash: ReturnType<typeof createHash>, filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
}

export async function fingerprintDirectory(root: string): Promise<string> {
  const expectedRoot = await realpath(root);
  const hash = createHash("sha256");
  const files = await collectFiles(expectedRoot);
  for (const relative of files) {
    const absolute = path.join(expectedRoot, relative);
    const info = await lstat(absolute);
    hash.update(relative).update("\0").update(String(info.mode)).update("\0");
    if (info.isSymbolicLink()) {
      hash.update("link\0").update(await readlink(absolute)).update("\0");
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > MAX_FILE_BYTES) throw new BrokerError("SOURCE_TOO_LARGE", `${relative} exceeds file limit`);
    hash.update(String(info.size)).update("\0");
    await hashFile(hash, absolute);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function fingerprintProject(project: ProjectConfig): Promise<string> {
  const current = await realpath(project.path);
  if (current !== project.realPath) throw new BrokerError("SOURCE_MOVED", "project real path changed", 409);
  return await fingerprintDirectory(current);
}
