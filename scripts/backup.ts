import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCos, loadCosSettings, uploadVerified } from "../src/cos/client.js";
import { runCommand } from "../src/ops/process.js";

interface BackupManifest {
  schemaVersion: 1;
  id: string;
  type: "daily" | "weekly" | "audit" | "rollback";
  createdAt: string;
  openclawVersion: string;
  archive: { fileName: string; size: number; sha256: string; encryption: "age"; compression: "zstd" };
  includes: string[];
  exclusions: string[];
  cos?: { bucket: string; region: string; key: string; verified: boolean };
}

const EXCLUSIONS = [
  "**/.env", "**/.env.*", "**/auth-profiles.json", "**/credentials/**", "**/*token*", "**/*secret*",
  "**/auth.json", "**/oauth*", "**/openclaw-agent.sqlite*",
  "**/.tmp/**", "**/tmp/**", "**/cache/**", "**/.git/**", "**/node_modules/**", "**/models_cache.json",
  "**/id_rsa*", "**/id_ed25519*", "**/*.pem", "**/*.key", "**/cos*.yaml", "recovery/**",
];

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function existing(root: string, candidates: string[]): Promise<string[]> {
  const output: string[] = [];
  for (const item of candidates) {
    if (await stat(path.join(root, item)).catch(() => null)) output.push(item);
  }
  return output;
}

async function createEncryptedArchive(
  projectRoot: string,
  dataDir: string,
  recipient: string,
  type: BackupManifest["type"],
  candidates: string[],
): Promise<{ manifest: BackupManifest; archivePath: string; manifestPath: string }> {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const includes = await existing(projectRoot, candidates);
  if (includes.length === 0) throw new Error(`no eligible paths for ${type} backup`);
  const tempDir = path.join(dataDir, "tmp", `backup-${id}`);
  const pendingDir = path.join(dataDir, "backups", "pending", type);
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  await mkdir(pendingDir, { recursive: true, mode: 0o750 });
  const plainPath = path.join(tempDir, `${id}.tar.zst`);
  const archivePath = path.join(pendingDir, `${id}.tar.zst.age`);
  const tar = await runCommand([
    "/usr/bin/tar", "--create", "--zstd", "--file", plainPath,
    "--numeric-owner", "--owner=0", "--group=0",
    ...EXCLUSIONS.flatMap((value) => ["--exclude", value]),
    ...includes,
  ], { cwd: projectRoot, timeoutMs: 30 * 60_000, maxOutputBytes: 128 * 1024 });
  if (tar.code !== 0 || tar.timedOut) throw new Error(`tar failed: ${tar.stderr.slice(0, 1000)}`);
  const age = await runCommand(["/usr/bin/age", "--encrypt", "--recipient", recipient, "--output", archivePath, plainPath], {
    timeoutMs: 30 * 60_000,
    maxOutputBytes: 64 * 1024,
  });
  await rm(plainPath, { force: true });
  await rm(tempDir, { recursive: true, force: true });
  if (age.code !== 0 || age.timedOut) throw new Error(`age encryption failed: ${age.stderr.slice(0, 1000)}`);
  const info = await stat(archivePath);
  const manifest: BackupManifest = {
    schemaVersion: 1,
    id,
    type,
    createdAt: new Date().toISOString(),
    openclawVersion: JSON.parse(await readFile(path.join(projectRoot, "node_modules", "openclaw", "package.json"), "utf8")).version as string,
    archive: {
      fileName: path.basename(archivePath),
      size: info.size,
      sha256: await sha256File(archivePath),
      encryption: "age",
      compression: "zstd",
    },
    includes,
    exclusions: EXCLUSIONS,
  };
  const manifestPath = `${archivePath}.manifest.json`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640, flag: "wx" });
  return { manifest, archivePath, manifestPath };
}

async function uploadPair(item: Awaited<ReturnType<typeof createEncryptedArchive>>): Promise<void> {
  const settings = await loadCosSettings();
  const cos = createCos(settings);
  const key = `${item.manifest.type}/${item.manifest.archive.fileName}`;
  await uploadVerified(cos, settings, item.archivePath, key, item.manifest.archive.sha256, item.manifest.archive.size);
  item.manifest.cos = { bucket: settings.bucket, region: settings.region, key, verified: true };
  await writeFile(item.manifestPath, `${JSON.stringify(item.manifest, null, 2)}\n`, { mode: 0o640 });
  const manifestInfo = await stat(item.manifestPath);
  const manifestHash = await sha256File(item.manifestPath);
  await uploadVerified(cos, settings, item.manifestPath, `${key}.manifest.json`, manifestHash, manifestInfo.size);
  const backupRoot = path.dirname(path.dirname(path.dirname(item.archivePath)));
  const uploadedDir = path.join(backupRoot, "uploaded", item.manifest.type);
  await mkdir(uploadedDir, { recursive: true, mode: 0o750 });
  await rename(item.archivePath, path.join(uploadedDir, path.basename(item.archivePath)));
  await rename(item.manifestPath, path.join(uploadedDir, path.basename(item.manifestPath)));
}

async function pendingItems(dataDir: string): Promise<Array<Awaited<ReturnType<typeof createEncryptedArchive>>>> {
  const items: Array<Awaited<ReturnType<typeof createEncryptedArchive>>> = [];
  for (const type of ["daily", "weekly", "audit", "rollback"] as const) {
    const directory = path.join(dataDir, "backups", "pending", type);
    for (const name of (await readdir(directory).catch(() => [])).filter((value) => value.endsWith(".tar.zst.age.manifest.json"))) {
      const manifestPath = path.join(directory, name);
      const archivePath = manifestPath.slice(0, -".manifest.json".length);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest;
      const info = await stat(archivePath);
      if (
        manifest.schemaVersion !== 1
        || manifest.type !== type
        || manifest.archive.fileName !== path.basename(archivePath)
        || manifest.archive.size !== info.size
        || manifest.archive.sha256 !== await sha256File(archivePath)
      ) {
        throw new Error(`pending backup failed local validation: ${path.basename(archivePath)}`);
      }
      items.push({ manifest, archivePath, manifestPath });
    }
  }
  return items;
}

export async function retryPendingBackups(
  dataDir = process.env.WECHAT_CLAWBOT_DATA ?? "/opt/WeChat-Open in/data",
): Promise<Record<string, unknown>> {
  const retried = [];
  const failed = [];
  for (const item of await pendingItems(dataDir)) {
    try {
      await uploadPair(item);
      retried.push({
        type: item.manifest.type,
        fileName: item.manifest.archive.fileName,
        size: item.manifest.archive.size,
        sha256: item.manifest.archive.sha256,
      });
    } catch (error) {
      failed.push({
        type: item.manifest.type,
        fileName: item.manifest.archive.fileName,
        error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
      });
    }
  }
  if (failed.length > 0) {
    throw new Error(`pending backup retry failed: ${JSON.stringify(failed)}`);
  }
  return { schemaVersion: 1, retriedAt: new Date().toISOString(), retried };
}

async function retainNewestTwo(directory: string): Promise<void> {
  const archives = [];
  for (const name of (await readdir(directory).catch(() => [])).filter((value) => value.endsWith(".tar.zst.age"))) {
    const info = await stat(path.join(directory, name));
    archives.push({ name, mtimeMs: info.mtimeMs });
  }
  archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of archives.slice(2)) {
    await rm(path.join(directory, stale.name), { force: true });
    await rm(path.join(directory, `${stale.name}.manifest.json`), { force: true });
  }
}

export async function runBackup(type: "daily" | "weekly", projectRoot = "/opt/WeChat-Open in"): Promise<Record<string, unknown>> {
  const dataDir = process.env.WECHAT_CLAWBOT_DATA ?? path.join(projectRoot, "data");
  const recipientFile = process.env.AGE_RECIPIENT_FILE ?? path.join(projectRoot, "config", "age-recipient.txt");
  const recipient = (await readFile(recipientFile, "utf8")).trim();
  if (!recipient.startsWith("age1")) throw new Error("age recipient is not configured");
  const categories: Array<{ type: BackupManifest["type"]; paths: string[] }> = [
    {
      type,
      paths: [
        "data/workspace/MEMORY.md", "data/workspace/memory", "data/state/agents", "data/state/cron",
        "data/tasks", "config/openclaw.json",
      ],
    },
    { type: "audit", paths: ["data/logs", "data/state/audit"] },
    { type: "rollback", paths: ["data/rollback"] },
  ];
  const created = [];
  for (const category of categories) {
    const item = await createEncryptedArchive(projectRoot, dataDir, recipient, category.type, category.paths);
    let uploaded = false;
    let uploadError: string | undefined;
    try {
      await uploadPair(item);
      uploaded = true;
    } catch (error) {
      uploadError = error instanceof Error ? error.message : String(error);
    }
    await retainNewestTwo(path.dirname(item.archivePath));
    await retainNewestTwo(path.join(dataDir, "backups", "uploaded", category.type));
    created.push({ type: category.type, archive: item.manifest.archive, uploaded, ...(uploadError ? { uploadError } : {}) });
  }
  const failed = created.filter((item) => !item.uploaded);
  if (failed.length > 0) {
    throw new Error(`backup upload failed: ${JSON.stringify(failed)}`);
  }
  return { schemaVersion: 1, createdAt: new Date().toISOString(), created };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const operation = process.argv.includes("--retry-pending")
    ? retryPendingBackups()
    : runBackup(process.argv.includes("--weekly") ? "weekly" : "daily");
  operation.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
    process.exitCode = 1;
  });
}
