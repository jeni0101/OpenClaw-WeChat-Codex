import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createCos, downloadObject, loadCosSettings } from "../src/cos/client.js";
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

async function main(): Promise<void> {
  const keyIndex = process.argv.indexOf("--key");
  const targetIndex = process.argv.indexOf("--target");
  const key = keyIndex >= 0 ? process.argv[keyIndex + 1] : undefined;
  const dryRun = process.argv.includes("--dry-run");
  if (!key || key.startsWith("/") || key.includes("..") || !key.endsWith(".tar.zst.age")) {
    throw new Error("--key must be a safe .tar.zst.age COS object key");
  }
  const projectRoot = "/opt/WeChat-Open in";
  const dataDir = process.env.WECHAT_CLAWBOT_DATA ?? path.join(projectRoot, "data");
  const restoreDir = path.join(dataDir, "tmp", `restore-${Date.now()}`);
  await mkdir(restoreDir, { recursive: true, mode: 0o700 });
  const encrypted = path.join(restoreDir, path.basename(key));
  const manifestPath = `${encrypted}.manifest.json`;
  const plain = path.join(restoreDir, "archive.tar.zst");
  const settings = await loadCosSettings();
  const cos = createCos(settings);
  try {
    await downloadObject(cos, settings, key, encrypted);
    await downloadObject(cos, settings, `${key}.manifest.json`, manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      archive?: { sha256?: string; size?: number };
    };
    const info = await stat(encrypted);
    if (info.size !== manifest.archive?.size || await sha256File(encrypted) !== manifest.archive?.sha256) {
      throw new Error("encrypted archive checksum or size mismatch");
    }
    const credentialDir = process.env.CREDENTIALS_DIRECTORY;
    if (!credentialDir) throw new Error("systemd age-key credential is required");
    const decrypted = await runCommand([
      "/usr/bin/age", "--decrypt", "--identity", path.join(credentialDir, "age-key"), "--output", plain, encrypted,
    ], { timeoutMs: 30 * 60_000, maxOutputBytes: 64 * 1024 });
    if (decrypted.code !== 0) throw new Error(`age decrypt failed: ${decrypted.stderr.slice(0, 500)}`);
    const listing = await runCommand(["/usr/bin/tar", "--list", "--zstd", "--file", plain], {
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    if (listing.code !== 0 || listing.truncated) throw new Error("archive listing failed or is too large");
    const entries = listing.stdout.split("\n").filter(Boolean);
    if (entries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
      throw new Error("archive contains an unsafe path");
    }
    if (dryRun) {
      process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, key, entries: entries.length, sha256: manifest.archive.sha256 })}\n`);
      return;
    }
    const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined;
    if (!target || !path.isAbsolute(target) || target === "/" || target === projectRoot) {
      throw new Error("--target must be an explicit empty recovery directory outside the live project root");
    }
    await mkdir(target, { recursive: false, mode: 0o700 });
    const extracted = await runCommand(["/usr/bin/tar", "--extract", "--zstd", "--file", plain, "--directory", target, "--no-same-owner"], {
      timeoutMs: 30 * 60_000,
      maxOutputBytes: 128 * 1024,
    });
    if (extracted.code !== 0) throw new Error(`extract failed: ${extracted.stderr.slice(0, 500)}`);
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: false, key, target, entries: entries.length })}\n`);
  } finally {
    await rm(restoreDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
  process.exitCode = 1;
});
