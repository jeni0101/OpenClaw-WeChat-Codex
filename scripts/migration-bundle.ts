import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCos, downloadObject, loadCosSettings, uploadVerified } from "../src/cos/client.js";
import { runCommand } from "../src/ops/process.js";

const TOP_LEVEL_FILES = new Set([
  ".env.example", ".gitignore", "README.md", "package.json", "package-lock.json",
  "tsconfig.json", "vitest.config.ts",
]);
const TOP_LEVEL_DIRECTORIES = new Set([
  "assets", "deploy", "docs", "plugins", "runtime-plugins", "scripts", "src", "test",
]);
const CONFIG_FILES = new Set([
  "age-recipient.txt", "cam-media-policy.json", "cam-provision-policy.json",
  "cam-runtime-policy.json", "openclaw.json", "projects.yaml",
]);

export function isMigrationSourcePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  const [first, second] = normalized.split("/");
  if (TOP_LEVEL_FILES.has(normalized)) return true;
  if (first === "config") return Boolean(second && CONFIG_FILES.has(second) && normalized.split("/").length === 2);
  return Boolean(first && TOP_LEVEL_DIRECTORIES.has(first));
}

export function shouldTraverseMigrationDirectory(current: string, relative: string): boolean {
  const first = relative.replaceAll("\\", "/").split("/")[0];
  if (!first) return false;
  if (first === "config") return current === "" && relative === "config";
  return TOP_LEVEL_DIRECTORIES.has(first);
}

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

async function collect(root: string, current = ""): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(path.join(root, current), { withFileTypes: true })) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (shouldTraverseMigrationDirectory(current, relative)) output.push(...await collect(root, relative));
    } else if (entry.isFile() && isMigrationSourcePath(relative)) {
      output.push(relative);
    }
  }
  return output.sort();
}

async function main(): Promise<void> {
  const projectRoot = process.env.WECHAT_CLAWBOT_ROOT ?? "/opt/WeChat-Open in";
  const dataDir = process.env.WECHAT_CLAWBOT_DATA ?? path.join(projectRoot, "data");
  const upload = process.argv.includes("--upload");
  const gitPrefix = ["/usr/bin/git", "-c", `safe.directory=${projectRoot}`, "-C", projectRoot];
  const revisionResult = await runCommand([...gitPrefix, "rev-parse", "HEAD"], {
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
  });
  const statusResult = await runCommand([...gitPrefix, "status", "--porcelain=v1", "--untracked-files=all"], {
    timeoutMs: 10_000,
    maxOutputBytes: 256 * 1024,
  });
  if (
    revisionResult.code !== 0
    || statusResult.code !== 0
    || statusResult.truncated
    || statusResult.stdout.trim().length > 0
  ) {
    throw new Error("migration releases require a committed, clean Git source tree");
  }
  const sourceRevision = revisionResult.stdout.trim();
  const recipient = (await readFile(path.join(projectRoot, "config", "age-recipient.txt"), "utf8")).trim();
  if (!recipient.startsWith("age1")) throw new Error("age recipient is not configured");
  const files = await collect(projectRoot);
  if (files.length < 20) throw new Error("migration source set is unexpectedly small");

  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const releaseDir = path.join(dataDir, "migration", "releases");
  const temporaryDir = path.join(dataDir, "tmp", `migration-${id}`);
  await mkdir(releaseDir, { recursive: true, mode: 0o750 });
  await mkdir(temporaryDir, { recursive: false, mode: 0o700 });
  const listPath = path.join(temporaryDir, "files.txt");
  const plainPath = path.join(temporaryDir, `${id}.tar.zst`);
  const archivePath = path.join(releaseDir, `${id}.tar.zst.age`);
  const manifestPath = `${archivePath}.manifest.json`;
  try {
    await writeFile(listPath, `${files.join("\n")}\n`, { mode: 0o600 });
    const tar = await runCommand([
      "/usr/bin/tar", "--create", "--zstd", "--file", plainPath,
      "--numeric-owner", "--owner=0", "--group=0", "--no-recursion", "--verbatim-files-from",
      "--files-from", listPath,
    ], { cwd: projectRoot, timeoutMs: 10 * 60_000, maxOutputBytes: 64 * 1024 });
    if (tar.code !== 0 || tar.timedOut) throw new Error(`migration tar failed: ${tar.stderr.slice(0, 1_000)}`);
    const age = await runCommand([
      "/usr/bin/age", "--encrypt", "--recipient", recipient, "--output", archivePath, plainPath,
    ], { timeoutMs: 10 * 60_000, maxOutputBytes: 64 * 1024 });
    if (age.code !== 0 || age.timedOut) throw new Error(`migration encryption failed: ${age.stderr.slice(0, 1_000)}`);

    const archiveInfo = await stat(archivePath);
    const sourceFiles = [];
    for (const relative of files) {
      const info = await stat(path.join(projectRoot, relative));
      sourceFiles.push({ path: relative, size: info.size, sha256: await sha256File(path.join(projectRoot, relative)) });
    }
    const manifest: Record<string, unknown> = {
      schemaVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      sourceRevision,
      target: { os: "ubuntu", version: "24.04", architecture: "x86_64", projectRoot },
      node: { version: "24.15.0", archiveSha256: "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6" },
      archive: {
        fileName: path.basename(archivePath),
        size: archiveInfo.size,
        sha256: await sha256File(archivePath),
        encryption: "age",
        compression: "zstd",
      },
      exclusions: ["data/**", ".storage/**", "node_modules/**", "recovery/**", ".git/**", ".env", "config/*.bak*"],
      sourceFiles,
    };
    if (upload) {
      const settings = await loadCosSettings();
      const cos = createCos(settings);
      const key = `rollback/migration/${path.basename(archivePath)}`;
      await uploadVerified(cos, settings, archivePath, key, String((manifest.archive as { sha256: string }).sha256), archiveInfo.size);
      manifest.cos = { bucket: settings.bucket, region: settings.region, key, verified: true };
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640, flag: "wx" });
    if (upload) {
      const settings = await loadCosSettings();
      const cos = createCos(settings);
      const key = `rollback/migration/${path.basename(manifestPath)}`;
      const info = await stat(manifestPath);
      const manifestSha256 = await sha256File(manifestPath);
      await uploadVerified(cos, settings, manifestPath, key, manifestSha256, info.size, "application/json");

      // HEAD metadata is necessary but not sufficient for a recovery release.
      // Read both objects back and compare bytes before reporting success.
      const readbackArchive = path.join(temporaryDir, "cos-readback.tar.zst.age");
      const readbackManifest = path.join(temporaryDir, "cos-readback.manifest.json");
      const archiveKey = String((manifest.cos as { key: string }).key);
      await downloadObject(cos, settings, archiveKey, readbackArchive);
      await downloadObject(cos, settings, key, readbackManifest);
      const readbackArchiveInfo = await stat(readbackArchive);
      const readbackManifestInfo = await stat(readbackManifest);
      if (
        readbackArchiveInfo.size !== archiveInfo.size
        || await sha256File(readbackArchive) !== (manifest.archive as { sha256: string }).sha256
        || readbackManifestInfo.size !== info.size
        || await sha256File(readbackManifest) !== manifestSha256
      ) {
        throw new Error("migration COS readback verification failed");
      }
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      archivePath,
      manifestPath,
      files: files.length,
      size: archiveInfo.size,
      sha256: (manifest.archive as { sha256: string }).sha256,
      uploaded: upload,
    })}\n`);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
    process.exitCode = 1;
  });
}
