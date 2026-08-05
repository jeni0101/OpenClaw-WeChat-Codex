import COS from "cos-nodejs-sdk-v5";
import { createReadStream } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export const SIMPLE_UPLOAD_LIMIT_BYTES = 8 * 1024 * 1024;
export const DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const COS_ATTEMPTS = 3;
const UPLOAD_ATTEMPT_TIMEOUT_MS = 15 * 60_000;

export interface CosSettings {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
  securityToken?: string;
}

async function readCredential(directory: string, name: string, required = true): Promise<string | undefined> {
  const value = await readFile(path.join(directory, name), "utf8").catch(() => undefined);
  const trimmed = value?.trim();
  if (required && !trimmed) throw new Error(`missing systemd credential: ${name}`);
  return trimmed;
}

export async function loadCosSettings(credentialDir = process.env.CREDENTIALS_DIRECTORY): Promise<CosSettings> {
  if (!credentialDir) throw new Error("systemd credential directory is required for COS access");
  const bucket = process.env.COS_BUCKET?.trim();
  const region = process.env.COS_REGION?.trim();
  if (!bucket) throw new Error("COS_BUCKET is required for COS access");
  if (!region) throw new Error("COS_REGION is required for COS access");
  const secretId = await readCredential(credentialDir, "cos-secret-id");
  const secretKey = await readCredential(credentialDir, "cos-secret-key");
  const securityToken = await readCredential(credentialDir, "cos-session-token", false);
  return {
    bucket,
    region,
    secretId: secretId!,
    secretKey: secretKey!,
    ...(securityToken ? { securityToken } : {}),
  };
}

export function createCos(settings: CosSettings): COS {
  return new COS({
    SecretId: settings.secretId,
    SecretKey: settings.secretKey,
    ...(settings.securityToken ? { SecurityToken: settings.securityToken } : {}),
    Protocol: "https:",
    FileParallelLimit: 1,
    ChunkParallelLimit: 8,
    ChunkRetryTimes: 3,
    SliceSize: 8 * 1024 * 1024,
    ChunkSize: 1 * 1024 * 1024,
    Timeout: 60_000,
  });
}

export function uploadStrategy(size: number): "put-object" | "multipart" {
  return size <= SIMPLE_UPLOAD_LIMIT_BYTES ? "put-object" : "multipart";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function uploadOnce(
  cos: COS,
  settings: CosSettings,
  localPath: string,
  key: string,
  sha256: string,
  size: number,
  contentType: string,
): Promise<{ ETag?: string }> {
  let taskId: string | undefined;
  let deadlineReached = false;
  const onTaskReady = (id: string): void => {
    taskId = id;
    if (deadlineReached) cos.cancelTask(id);
  };
  const common = {
    Bucket: settings.bucket,
    Region: settings.region,
    Key: key,
    ContentLength: size,
    ContentType: key.endsWith(".json") ? "application/json" : contentType,
    ACL: "private" as const,
    ServerSideEncryption: "AES256",
    "x-cos-meta-sha256": sha256,
    "x-cos-meta-size": String(size),
    onTaskReady,
  };
  let body: ReturnType<typeof createReadStream> | undefined;
  const operation = uploadStrategy(size) === "put-object"
    ? cos.putObject({ ...common, Body: (body = createReadStream(localPath)) })
    : cos.sliceUploadFile({
      ...common,
      FilePath: localPath,
      ChunkSize: 1 * 1024 * 1024,
      SliceSize: 1 * 1024 * 1024,
    });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      deadlineReached = true;
      if (taskId) cos.cancelTask(taskId);
      reject(new Error(`COS upload attempt exceeded ${UPLOAD_ATTEMPT_TIMEOUT_MS} ms`));
    }, UPLOAD_ATTEMPT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    body?.destroy();
  }
}

export async function uploadVerified(
  cos: COS,
  settings: CosSettings,
  localPath: string,
  key: string,
  sha256: string,
  size: number,
  contentType = "application/octet-stream",
): Promise<Record<string, unknown>> {
  let uploaded: { ETag?: string } | undefined;
  let uploadError: unknown;
  for (let attempt = 1; attempt <= COS_ATTEMPTS; attempt += 1) {
    try {
      uploaded = await uploadOnce(cos, settings, localPath, key, sha256, size, contentType);
      uploadError = undefined;
      break;
    } catch (error) {
      uploadError = error;
      if (attempt < COS_ATTEMPTS) await delay(attempt * 2_000);
    }
  }
  if (!uploaded) throw uploadError;

  let head: Awaited<ReturnType<COS["headObject"]>> | undefined;
  let headError: unknown;
  for (let attempt = 1; attempt <= COS_ATTEMPTS; attempt += 1) {
    try {
      head = await cos.headObject({ Bucket: settings.bucket, Region: settings.region, Key: key });
      headError = undefined;
      break;
    } catch (error) {
      headError = error;
      if (attempt < COS_ATTEMPTS) await delay(attempt * 2_000);
    }
  }
  if (!head) throw headError;

  const headerEntries = Object.entries({
    ...(head as unknown as Record<string, unknown>),
    ...((head.headers ?? {}) as Record<string, unknown>),
  }).map(([name, value]) => [name.toLowerCase(), value] as const);
  const headers = Object.fromEntries(headerEntries) as Record<string, unknown>;
  const remoteSha = String(headers["x-cos-meta-sha256"] ?? "");
  const remoteSize = String(headers["x-cos-meta-size"] ?? "");
  const serverEncryption = String(headers["x-cos-server-side-encryption"] ?? "");
  if (remoteSha !== sha256 || remoteSize !== String(size)) {
    throw new Error(`COS metadata verification failed for ${key}`);
  }
  if (serverEncryption.toUpperCase() !== "AES256") {
    throw new Error(`COS server-side encryption verification failed for ${key}`);
  }
  return { key, etag: uploaded.ETag, sha256, size, serverEncryption, strategy: uploadStrategy(size) };
}

export function signedDownloadUrl(cos: COS, settings: CosSettings, key: string, expiresSeconds = 1800): string {
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 60 || expiresSeconds > 3600) {
    throw new Error("signed COS URL expiry must be between 60 and 3600 seconds");
  }
  const url = cos.getObjectUrl({
    Bucket: settings.bucket,
    Region: settings.region,
    Key: key,
    Sign: true,
    Method: "GET",
    Expires: expiresSeconds,
    Protocol: "https:",
  });
  if (!url.startsWith("https://")) throw new Error("COS did not return an HTTPS signed URL");
  return url;
}

export async function downloadObject(cos: COS, settings: CosSettings, key: string, outputPath: string): Promise<void> {
  const output = await open(outputPath, "wx", 0o600);
  try {
    let head: Awaited<ReturnType<COS["headObject"]>> | undefined;
    let headError: unknown;
    for (let attempt = 1; attempt <= COS_ATTEMPTS; attempt += 1) {
      try {
        head = await cos.headObject({ Bucket: settings.bucket, Region: settings.region, Key: key });
        headError = undefined;
        break;
      } catch (error) {
        headError = error;
        if (attempt < COS_ATTEMPTS) await delay(attempt * 2_000);
      }
    }
    if (!head) throw headError;

    const headerEntries = Object.entries({
      ...(head as unknown as Record<string, unknown>),
      ...((head.headers ?? {}) as Record<string, unknown>),
    }).map(([name, value]) => [name.toLowerCase(), value] as const);
    const headers = Object.fromEntries(headerEntries) as Record<string, unknown>;
    const sizeValue = headers["content-length"] ?? headers["x-cos-meta-size"];
    const size = Number(sizeValue);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("COS download metadata has an invalid object size");
    }

    for (let start = 0; start < size; start += DOWNLOAD_CHUNK_BYTES) {
      const end = Math.min(start + DOWNLOAD_CHUNK_BYTES, size) - 1;
      const expectedLength = end - start + 1;
      let body: Buffer | undefined;
      let chunkError: unknown;
      for (let attempt = 1; attempt <= COS_ATTEMPTS; attempt += 1) {
        try {
          const result = await cos.getObject({
            Bucket: settings.bucket,
            Region: settings.region,
            Key: key,
            Range: `bytes=${start}-${end}`,
            ...(head.ETag ? { IfMatch: head.ETag } : {}),
          });
          if (!Buffer.isBuffer(result.Body) || result.Body.length !== expectedLength) {
            throw new Error(`COS returned ${result.Body?.length ?? 0} bytes; expected ${expectedLength}`);
          }
          body = result.Body;
          chunkError = undefined;
          break;
        } catch (error) {
          chunkError = error;
          if (attempt < COS_ATTEMPTS) await delay(attempt * 2_000);
        }
      }
      if (!body) {
        throw new Error(`COS ranged download failed for bytes ${start}-${end}`, { cause: chunkError });
      }

      let written = 0;
      while (written < body.length) {
        const result = await output.write(body, written, body.length - written, start + written);
        if (result.bytesWritten <= 0) throw new Error("COS download could not write the local file");
        written += result.bytesWritten;
      }
    }
    await output.close();
  } catch (error) {
    await output.close().catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
}
