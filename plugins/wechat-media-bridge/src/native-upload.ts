import crypto from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type UploadMethod = "POST" | "PUT";

export interface SourceIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface VerifiedUploadSource {
  identity: SourceIdentity;
  md5: string;
  sha256: string;
  size: number;
}

export interface StreamUploadResponse {
  status: number;
  downloadParam?: string;
  responseHeaders: Record<string, string>;
  responseBytes: number;
  responseSha256: string;
  errorBodyPreview?: string;
  timingsMs: Record<string, number>;
  requestBody?: {
    plaintextReadBytes: number;
    ciphertextProducedBytes: number;
    contentLength: number;
    requestWritableEnded: boolean;
    requestWritableFinished: boolean;
    socketBytesRead: number;
    socketBytesWritten: number;
  };
  tls?: Record<string, unknown>;
}

export type UploadRequestImplementation = (
  url: URL,
  options: https.RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export type NativeUploadErrorCode =
  | "SOURCE_HASH_CHANGED"
  | "WEIXIN_PRESIGN_FAILED"
  | "WEIXIN_UPLOAD_URL_MISSING"
  | "WEIXIN_CDN_4XX"
  | "WEIXIN_CDN_5XX"
  | "WEIXIN_CDN_PROTOCOL"
  | "WEIXIN_CDN_NETWORK"
  | "WEIXIN_CDN_TIMEOUT";

export class NativeUploadError extends Error {
  constructor(
    public readonly code: NativeUploadErrorCode,
    message: string,
    public readonly details: {
      attempt?: number;
      method?: UploadMethod;
      status?: number;
    } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NativeUploadError";
  }
}

export interface UploadAttemptEvent {
  attempt: number;
  method: UploadMethod;
  response?: StreamUploadResponse;
  errorCode?: NativeUploadErrorCode;
}

export interface ExecuteUploadStrategyOptions<TTicket> {
  methods: readonly UploadMethod[];
  acquire: (method: UploadMethod, attempt: number) => Promise<TTicket>;
  upload: (ticket: TTicket, method: UploadMethod, attempt: number) => Promise<StreamUploadResponse>;
  onAttempt?: (event: UploadAttemptEvent) => Promise<void> | void;
  delay?: (milliseconds: number) => Promise<void>;
}

function identityOf(info: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): SourceIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

function sameIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function redactErrorBody(value: Buffer): string | undefined {
  if (value.length === 0) return undefined;
  const printable = value.toString("utf8")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "\uFFFD")
    .replace(/https?:\/\/\S+/gi, "<redacted-url>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/(?:encrypted_query_param|upload_param|aeskey|token)=?[^&\s"]+/gi, "$1=<redacted>")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "<redacted-secret>")
    .trim();
  return printable ? printable.slice(0, 1024) : undefined;
}

function selectedResponseHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of [
    "content-length",
    "content-type",
    "date",
    "server",
    "transfer-encoding",
    "via",
    "x-cache",
    "x-error-message",
    "x-request-id",
    "x-cdn-request-id",
  ]) {
    const value = headers[name];
    if (typeof value === "string") selected[name] = value.slice(0, 256);
  }
  return selected;
}

export function aesEcbPaddedSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid plaintext size");
  return (Math.floor(size / 16) + 1) * 16;
}

export function uploadTimeoutMs(size: number): number {
  // The trusted cross-region egress can temporarily fall below 64 KiB/s.
  // Budget for 32 KiB/s plus connection/CDN processing overhead, while still
  // enforcing a finite upper bound near the 50 MiB local safety limit.
  const transferMs = Math.ceil(size / (32 * 1024)) * 1_000;
  return Math.max(120_000, Math.min(1_800_000, transferMs + 120_000));
}

export function uploadMethodSequence(primary: UploadMethod, attempts = 4): UploadMethod[] {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 8) throw new Error("invalid upload attempt count");
  const alternate: UploadMethod = primary === "POST" ? "PUT" : "POST";
  return Array.from({ length: attempts }, (_, index) => index % 2 === 0 ? primary : alternate);
}

export async function verifyUploadSource(
  filePath: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<VerifiedUploadSource> {
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== expectedSize) {
      throw new NativeUploadError("SOURCE_HASH_CHANGED", "source identity or size changed before upload");
    }
    const md5 = crypto.createHash("md5");
    const sha256 = crypto.createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      md5.update(buffer);
      sha256.update(buffer);
    }
    const after = await handle.stat();
    const digest = sha256.digest("hex");
    if (
      size !== expectedSize
      || digest !== expectedSha256
      || !sameIdentity(identityOf(before), identityOf(after))
    ) {
      throw new NativeUploadError("SOURCE_HASH_CHANGED", "source changed while it was being verified");
    }
    return {
      identity: identityOf(after),
      md5: md5.digest("hex"),
      sha256: digest,
      size,
    };
  } finally {
    await handle.close();
  }
}

export async function uploadEncryptedFile(options: {
  filePath: string;
  source: VerifiedUploadSource;
  aesKey: Buffer;
  method: UploadMethod;
  url: URL;
  agent?: https.Agent;
  timeoutMs?: number;
  requestImpl?: UploadRequestImplementation;
}): Promise<StreamUploadResponse> {
  if (options.aesKey.length !== 16) throw new Error("AES-128 key must be exactly 16 bytes");
  const requestImpl = options.requestImpl ?? https.request;
  const handle = await open(options.filePath, "r");
  const before = await handle.stat();
  if (!sameIdentity(options.source.identity, identityOf(before))) {
    await handle.close();
    throw new NativeUploadError("SOURCE_HASH_CHANGED", "source changed before an upload attempt");
  }

  const started = performance.now();
  const timingsMs: Record<string, number> = {};
  const contentLength = aesEcbPaddedSize(options.source.size);
  let plaintextReadBytes = 0;
  let ciphertextProducedBytes = 0;
  let tls: Record<string, unknown> | undefined;
  let request: ClientRequest | undefined;
  try {
    const responsePromise = new Promise<StreamUploadResponse>((resolve, reject) => {
      request = requestImpl(options.url, {
        method: options.method,
        ...(options.agent ? { agent: options.agent } : {}),
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(contentLength),
        },
        timeout: options.timeoutMs ?? uploadTimeoutMs(options.source.size),
      }, (response) => {
        timingsMs.firstByte = elapsed(started);
        const responseHash = crypto.createHash("sha256");
        const previewChunks: Buffer[] = [];
        let previewBytes = 0;
        let responseBytes = 0;
        response.on("data", (chunk: Buffer) => {
          const buffer = Buffer.from(chunk);
          responseBytes += buffer.length;
          responseHash.update(buffer);
          if (previewBytes < 4_096) {
            const bounded = buffer.subarray(0, 4_096 - previewBytes);
            previewChunks.push(bounded);
            previewBytes += bounded.length;
          }
        });
        response.once("end", () => {
          timingsMs.complete = elapsed(started);
          const downloadParam = response.headers["x-encrypted-param"];
          const preview = redactErrorBody(Buffer.concat(previewChunks));
          const result: StreamUploadResponse = {
            status: response.statusCode ?? 0,
            responseHeaders: selectedResponseHeaders(response.headers),
            responseBytes,
            responseSha256: responseHash.digest("hex"),
            timingsMs,
            requestBody: {
              plaintextReadBytes,
              ciphertextProducedBytes,
              contentLength,
              requestWritableEnded: request?.writableEnded ?? false,
              requestWritableFinished: request?.writableFinished ?? false,
              socketBytesRead: request?.socket?.bytesRead ?? 0,
              socketBytesWritten: request?.socket?.bytesWritten ?? 0,
            },
            ...(typeof downloadParam === "string" ? { downloadParam } : {}),
            ...(preview ? { errorBodyPreview: preview } : {}),
            ...(tls ? { tls } : {}),
          };
          // Some CDN edges reject an upload before consuming the declared
          // request body. Stop the producer after the complete error response
          // is captured so backpressure cannot leave the pipeline hanging.
          if (result.status !== 200) request?.destroy();
          resolve(result);
        });
        response.once("error", reject);
      });
      request.once("socket", (socket) => {
        timingsMs.socket = elapsed(started);
        socket.once("lookup", () => { timingsMs.dns = elapsed(started); });
        socket.once("connect", () => { timingsMs.connect = elapsed(started); });
        socket.once("secureConnect", () => {
          timingsMs.tls = elapsed(started);
          const secure = socket as import("node:tls").TLSSocket;
          if (typeof secure.getProtocol === "function") {
            tls = {
              protocol: secure.getProtocol(),
              cipher: secure.getCipher()?.name,
              authorized: secure.authorized,
              remoteFamily: secure.remoteFamily,
              remoteAddressTag: secure.remoteAddress
                ? crypto.createHash("sha256").update(secure.remoteAddress).digest("hex").slice(0, 12)
                : undefined,
            };
          }
        });
        socket.on("error", () => undefined);
      });
      request.once("timeout", () => {
        request?.destroy(new NativeUploadError("WEIXIN_CDN_TIMEOUT", "Weixin CDN upload timed out", {
          method: options.method,
        }));
      });
      request.once("error", reject);
    });

    const cipher = crypto.createCipheriv("aes-128-ecb", options.aesKey, null);
    cipher.setAutoPadding(true);
    const plaintextMeter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        plaintextReadBytes += chunk.length;
        callback(null, chunk);
      },
    });
    const ciphertextMeter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        ciphertextProducedBytes += chunk.length;
        callback(null, chunk);
      },
    });
    const pipePromise = pipeline(
      handle.createReadStream({ autoClose: false }),
      plaintextMeter,
      cipher,
      ciphertextMeter,
      request!,
    ).catch((error: unknown) => {
      request?.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    const response = await responsePromise;
    await pipePromise;
    // A server may send an error response and close the upload stream before
    // consuming the whole body. In that case pipeline() can close the
    // FileHandle even with autoClose:false, so validate the current path
    // identity instead of masking the authoritative CDN response with EBADF.
    const after = await stat(options.filePath);
    if (!sameIdentity(options.source.identity, identityOf(after))) {
      throw new NativeUploadError("SOURCE_HASH_CHANGED", "source changed during an upload attempt");
    }
    return response;
  } finally {
    request?.destroy();
    await handle.close();
  }
}

export async function executeUploadStrategy<TTicket>(
  options: ExecuteUploadStrategyOptions<TTicket>,
): Promise<{
  attempt: number;
  method: UploadMethod;
  response: StreamUploadResponse;
  ticket: TTicket;
}> {
  if (options.methods.length === 0) throw new Error("upload strategy has no methods");
  const delay = options.delay ?? (async (milliseconds: number) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
  const retryDelayMs = (index: number): number => 5_000 * 3 ** index;
  let lastError: NativeUploadError | undefined;

  for (let index = 0; index < options.methods.length; index += 1) {
    const attempt = index + 1;
    const method = options.methods[index]!;
    let ticket: TTicket;
    try {
      ticket = await options.acquire(method, attempt);
    } catch (error) {
      const classified = error instanceof NativeUploadError
        ? error
        : new NativeUploadError("WEIXIN_PRESIGN_FAILED", "failed to acquire a Weixin CDN upload task", {
            attempt,
            method,
          }, { cause: error });
      await options.onAttempt?.({ attempt, method, errorCode: classified.code });
      if (classified.code === "SOURCE_HASH_CHANGED") throw classified;
      lastError = classified;
      if (index < options.methods.length - 1) await delay(retryDelayMs(index));
      continue;
    }

    try {
      const response = await options.upload(ticket, method, attempt);
      if (response.status === 200 && response.downloadParam) {
        await options.onAttempt?.({ attempt, method, response });
        return { attempt, method, response, ticket };
      }
      const code: NativeUploadErrorCode = response.status >= 400 && response.status < 500
        ? "WEIXIN_CDN_4XX"
        : response.status >= 500
          ? "WEIXIN_CDN_5XX"
          : "WEIXIN_CDN_PROTOCOL";
      const classified = new NativeUploadError(code, `Weixin CDN upload failed with status ${response.status}`, {
        attempt,
        method,
        status: response.status,
      });
      await options.onAttempt?.({ attempt, method, response, errorCode: code });
      if (code === "WEIXIN_CDN_4XX") throw classified;
      lastError = classified;
    } catch (error) {
      if (error instanceof NativeUploadError && error.code === "WEIXIN_CDN_4XX") throw error;
      const classified = error instanceof NativeUploadError
        ? error
        : new NativeUploadError("WEIXIN_CDN_NETWORK", "Weixin CDN upload request failed", {
            attempt,
            method,
          }, { cause: error });
      if (
        classified.code === "SOURCE_HASH_CHANGED"
        || classified.code === "WEIXIN_CDN_4XX"
      ) {
        await options.onAttempt?.({ attempt, method, errorCode: classified.code });
        throw classified;
      }
      if (!lastError || classified.code !== "WEIXIN_CDN_PROTOCOL") {
        lastError = classified;
        await options.onAttempt?.({ attempt, method, errorCode: classified.code });
      }
    }
    if (index < options.methods.length - 1) await delay(retryDelayMs(index));
  }

  throw lastError ?? new NativeUploadError("WEIXIN_CDN_PROTOCOL", "Weixin CDN upload did not return a usable response");
}
