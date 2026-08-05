import { readdir, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { BrokerError } from "./errors.js";
import { runCommand } from "./process.js";
import type { BrokerOptions, ChangeKind } from "./types.js";

const GIB = 1024 ** 3;
export const PROJECT_REFUSE_BYTES = Math.floor(8.5 * GIB);

export interface BudgetStatus {
  volume: { totalBytes: number; usedBytes: number; freeBytes: number; usedRatio: number };
  projectAllocatedBytes: number;
  levels: { cleanup: boolean; noNewStages: boolean; readOnly: boolean; projectWriteRefused: boolean };
}

async function clearChildren(root: string): Promise<void> {
  for (const entry of await readdir(root).catch(() => [])) {
    await rm(path.join(root, entry), { recursive: true, force: true });
  }
}

async function clearStaleChildren(root: string, olderThanMs: number): Promise<void> {
  const cutoff = Date.now() - olderThanMs;
  for (const entry of await readdir(root).catch(() => [])) {
    const target = path.join(root, entry);
    const info = await stat(target).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(target, { recursive: true, force: true });
  }
}

export async function readBudget(options: BrokerOptions): Promise<BudgetStatus> {
  const fs = await statfs(options.dataDir);
  const totalBytes = Number(fs.blocks) * Number(fs.bsize);
  const freeBytes = Number(fs.bavail) * Number(fs.bsize);
  const usedBytes = totalBytes - freeBytes;
  const usedRatio = totalBytes === 0 ? 1 : usedBytes / totalBytes;
  const projectRoot = path.dirname(path.dirname(options.registryPath));
  const du = await runCommand(["/usr/bin/du", "-sx", "--block-size=1", "--one-file-system", projectRoot], {
    maxOutputBytes: 16 * 1024,
    timeoutMs: 60_000,
  });
  const projectAllocatedBytes = du.code === 0 ? Number.parseInt(du.stdout.split(/\s+/)[0] ?? "0", 10) : PROJECT_REFUSE_BYTES + 1;
  return {
    volume: { totalBytes, usedBytes, freeBytes, usedRatio },
    projectAllocatedBytes,
    levels: {
      cleanup: usedRatio >= 0.70,
      noNewStages: usedRatio >= 0.85,
      readOnly: usedRatio >= 0.95,
      projectWriteRefused: projectAllocatedBytes >= PROJECT_REFUSE_BYTES,
    },
  };
}

export async function assertWriteBudget(options: BrokerOptions, kind: ChangeKind): Promise<BudgetStatus> {
  let status = await readBudget(options);
  if (status.levels.cleanup) {
    await clearChildren(path.join(options.dataDir, "cache"));
    await clearStaleChildren(path.join(options.dataDir, "tmp"), 24 * 60 * 60 * 1000);
    status = await readBudget(options);
  }
  if (status.levels.projectWriteRefused) {
    throw new BrokerError("PROJECT_DISK_BUDGET", "project allocation reached 8.5 GiB; new write operations are refused", 507);
  }
  if (status.levels.readOnly) {
    throw new BrokerError("DATA_VOLUME_READ_ONLY", "data volume reached 95%; only chat and read-only inspection remain available", 507);
  }
  if (kind === "develop" && status.levels.noNewStages) {
    throw new BrokerError("STAGING_DISABLED", "data volume reached 85%; new development stages are disabled", 507);
  }
  return status;
}
