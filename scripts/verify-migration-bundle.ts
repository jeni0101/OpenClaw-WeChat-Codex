import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../src/ops/process.js";

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

async function latestManifest(releaseDir: string): Promise<string> {
  const candidates = [];
  for (const name of (await readdir(releaseDir)).filter((value) => value.endsWith(".tar.zst.age.manifest.json"))) {
    const filePath = path.join(releaseDir, name);
    candidates.push({ filePath, mtimeMs: (await stat(filePath)).mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!candidates[0]) throw new Error("no migration release manifest found");
  return candidates[0].filePath;
}

async function main(): Promise<void> {
  const projectRoot = process.env.WECHAT_CLAWBOT_ROOT ?? "/opt/WeChat-Open in";
  const dataDir = process.env.WECHAT_CLAWBOT_DATA ?? path.join(projectRoot, "data");
  const manifestIndex = process.argv.indexOf("--manifest");
  const identityIndex = process.argv.indexOf("--identity");
  const manifestPath = manifestIndex >= 0
    ? path.resolve(process.argv[manifestIndex + 1] ?? "")
    : await latestManifest(path.join(dataDir, "migration", "releases"));
  const identityPath = identityIndex >= 0
    ? path.resolve(process.argv[identityIndex + 1] ?? "")
    : path.join(projectRoot, "recovery", "wechat-clawbot-recovery.agekey");
  const archivePath = manifestPath.slice(0, -".manifest.json".length);
  const releaseRoot = path.resolve(dataDir, "migration", "releases");
  if (!path.resolve(manifestPath).startsWith(`${releaseRoot}${path.sep}`) || !archivePath.endsWith(".tar.zst.age")) {
    throw new Error("manifest must be inside the managed migration release directory");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    archive?: { sha256?: string; size?: number };
    sourceFiles?: Array<{ path?: string; size?: number; sha256?: string }>;
  };
  const archiveInfo = await stat(archivePath);
  if (
    archiveInfo.size !== manifest.archive?.size
    || await sha256File(archivePath) !== manifest.archive?.sha256
    || !Array.isArray(manifest.sourceFiles)
  ) {
    throw new Error("migration archive manifest validation failed");
  }

  const temporaryDir = await mkdtemp(path.join(dataDir, "tmp", "migration-verify-"));
  const plain = path.join(temporaryDir, "release.tar.zst");
  const extracted = path.join(temporaryDir, "extracted");
  try {
    const decrypt = await runCommand([
      "/usr/bin/age", "--decrypt", "--identity", identityPath, "--output", plain, archivePath,
    ], { timeoutMs: 10 * 60_000, maxOutputBytes: 64 * 1024 });
    if (decrypt.code !== 0 || decrypt.timedOut) throw new Error(`migration decrypt failed: ${decrypt.stderr.slice(0, 500)}`);
    const listing = await runCommand(["/usr/bin/tar", "--list", "--zstd", "--file", plain], {
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    if (listing.code !== 0 || listing.truncated) throw new Error("migration archive listing failed");
    const entries = listing.stdout.split("\n").filter(Boolean);
    if (
      entries.length !== manifest.sourceFiles.length
      || entries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))
    ) {
      throw new Error("migration archive contains an unsafe or unexpected path set");
    }
    const create = await runCommand(["/usr/bin/mkdir", "--mode=0700", extracted]);
    if (create.code !== 0) throw new Error("unable to create migration verification directory");
    const extract = await runCommand([
      "/usr/bin/tar", "--extract", "--zstd", "--file", plain, "--directory", extracted, "--no-same-owner",
    ], { timeoutMs: 10 * 60_000, maxOutputBytes: 64 * 1024 });
    if (extract.code !== 0 || extract.timedOut) throw new Error("migration archive extraction failed");
    for (const source of manifest.sourceFiles) {
      if (
        typeof source.path !== "string"
        || !source.path
        || source.path.startsWith("/")
        || source.path.split("/").includes("..")
        || typeof source.size !== "number"
        || typeof source.sha256 !== "string"
      ) {
        throw new Error("migration source manifest entry is invalid");
      }
      const target = path.join(extracted, source.path);
      const info = await stat(target);
      if (!info.isFile() || info.size !== source.size || await sha256File(target) !== source.sha256) {
        throw new Error(`migration source verification failed: ${source.path}`);
      }
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      archivePath,
      manifestPath,
      files: entries.length,
      sha256: manifest.archive.sha256,
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
