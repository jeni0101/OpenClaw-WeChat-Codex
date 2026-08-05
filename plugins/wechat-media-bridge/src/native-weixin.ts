import crypto from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import https from "node:https";
import path from "node:path";

import { getUploadUrl } from "@tencent-weixin/openclaw-weixin/dist/src/api/api.js";
import { sendMessageItemWeixin } from "@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js";
import {
  aesEcbPaddedSize,
  executeUploadStrategy,
  NativeUploadError,
  type StreamUploadResponse,
  type UploadMethod,
  type VerifiedUploadSource,
  uploadEncryptedFile,
  verifyUploadSource,
} from "./native-upload.js";
import { parseLoopbackSocksProxy, SocksHttpsAgent } from "./socks-https.js";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_DIAGNOSTIC_BYTES = 25 * 1024 * 1024;

interface AccountRecord {
  token?: string;
  baseUrl?: string;
}

export async function readOwnerContextToken(contextFile: string, expectedOwner: string): Promise<string> {
  const contexts = JSON.parse(await readFile(contextFile, "utf8")) as Record<string, unknown>;
  const ownerEntries = Object.entries(contexts).filter(
    ([owner, token]) => owner && typeof token === "string" && token.length > 0,
  );
  if (ownerEntries.length !== 1 || ownerEntries[0]![0] !== expectedOwner) {
    throw new NativeDeliveryError(
      "WEIXIN_OWNER_CONTEXT_MISMATCH",
      "Weixin owner context does not match the configured account",
    );
  }
  return ownerEntries[0]![1] as string;
}

export async function waitForContextTokenChange(options: {
  contextFile: string;
  expectedOwner: string;
  previousToken: string;
  milliseconds: number;
}): Promise<boolean> {
  const deadline = Date.now() + options.milliseconds;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, remaining)));
    const current = await readOwnerContextToken(
      options.contextFile,
      options.expectedOwner,
    ).catch(() => options.previousToken);
    if (current !== options.previousToken) return true;
  }
  return false;
}

interface UploadedFile {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

type NativeMediaKind = "file" | "image" | "video";
type UploadUrlSource = "full" | "param";

interface UploadTicket {
  aeskey: Buffer;
  filekey: string;
  source: VerifiedUploadSource;
  target: URL;
  targetSource: UploadUrlSource;
}

interface UploadUrlResponse {
  ret?: number;
  errmsg?: string;
  upload_param?: string;
  upload_full_url?: string;
}

export interface ExactNativeSendOptions {
  accountId: string;
  dataDir: string;
  expectedOwner: string;
  expectedSha256: string;
  expectedSize: number;
  filePath: string;
  fileName: string;
  transferId: string;
  caption?: string;
  maxUploadAttempts?: number;
  queueAttempt?: number;
  onUploadAttempt?: (event: {
    attempt: number;
    errorCode?: string;
    status?: number;
  }) => Promise<void> | void;
}

function taskIdFromUrl(raw: string): string | undefined {
  const value = new URL(raw).searchParams.get("taskid");
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function assertCdnTarget(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== "novac2c.cdn.weixin.qq.com" || url.pathname !== "/c2c/upload") {
    throw new NativeUploadError("WEIXIN_UPLOAD_URL_MISSING", "Weixin returned an untrusted CDN upload target");
  }
  return url;
}

async function getUploadUrlThroughAgent(options: {
  agent: https.Agent;
  baseUrl: string;
  token: string;
  body: Record<string, unknown>;
}): Promise<UploadUrlResponse> {
  const base = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
  const url = new URL("ilink/bot/getuploadurl", base);
  if (url.protocol !== "https:" || url.hostname !== "ilinkai.weixin.qq.com") {
    throw new NativeUploadError("WEIXIN_PRESIGN_FAILED", "refusing an untrusted proxied getUploadUrl endpoint");
  }
  const body = Buffer.from(JSON.stringify({
    ...options.body,
    base_info: {
      channel_version: "2.4.6",
      bot_agent: "OpenClaw",
    },
  }), "utf8");
  const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
  return await new Promise<UploadUrlResponse>((resolve, reject) => {
    const request = https.request(url, {
      method: "POST",
      agent: options.agent,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(body.byteLength),
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${options.token}`,
        "X-WECHAT-UIN": uin,
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": "132102",
      },
      timeout: 20_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          request.destroy(new NativeUploadError(
            "WEIXIN_PRESIGN_FAILED",
            "proxied getUploadUrl response exceeded 64 KiB",
          ));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("end", () => {
        if (response.statusCode !== 200) {
          reject(new NativeUploadError(
            "WEIXIN_PRESIGN_FAILED",
            `proxied getUploadUrl returned HTTP ${response.statusCode ?? 0}`,
          ));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as UploadUrlResponse);
        } catch (error) {
          reject(new NativeUploadError(
            "WEIXIN_PRESIGN_FAILED",
            "proxied getUploadUrl returned invalid JSON",
            {},
            { cause: error },
          ));
        }
      });
      response.once("error", reject);
    });
    request.once("timeout", () => request.destroy(new NativeUploadError(
      "WEIXIN_PRESIGN_FAILED",
      "proxied getUploadUrl timed out",
    )));
    request.once("error", reject);
    request.end(body);
  });
}

export function nativeMediaKind(fileName: string): NativeMediaKind {
  const extension = path.extname(fileName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(extension)) return "image";
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(extension)) return "video";
  return "file";
}

export class NativeDeliveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NativeDeliveryError";
  }
}

export function nativeMessageClientId(
  transferId: string,
  kind: "caption" | "media",
): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transferId)) {
    throw new Error("invalid native transfer id");
  }
  return `openclaw-weixin-${transferId.toLowerCase()}-${kind}`;
}

export function configuredUploadMethod(value = process.env.WEIXIN_CDN_PRIMARY_METHOD): UploadMethod {
  return value?.trim().toUpperCase() === "PUT" ? "PUT" : "POST";
}

export function configuredUploadMethods(
  primaryValue = process.env.WEIXIN_CDN_PRIMARY_METHOD,
  alternateValue = process.env.WEIXIN_CDN_ALTERNATE_METHOD,
  attempts = 4,
): UploadMethod[] {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 8) {
    throw new Error("upload attempt count must be between 1 and 8");
  }
  const primary = configuredUploadMethod(primaryValue);
  const normalizedAlternate = alternateValue?.trim().toUpperCase();
  const alternate = normalizedAlternate === "POST" || normalizedAlternate === "PUT"
    ? normalizedAlternate
    : undefined;
  if (!alternate || alternate === primary) return Array.from({ length: attempts }, () => primary);
  return Array.from({ length: attempts }, (_, index) => index % 2 === 0 ? primary : alternate);
}

export function retryDelaysForSize(size: number): number[] {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid upload size");
  if (size >= 16 * 1024 * 1024) return [60_000, 120_000, 180_000, 240_000, 300_000];
  // Generated Office files around 1–4 MiB can trigger temporary Tencent
  // throttling when fresh taskids are requested only seconds apart.
  if (size >= 512 * 1024) return [60_000, 120_000, 240_000];
  return [5_000, 15_000, 45_000];
}

const NATIVE_SEND_RETRY_DELAYS = [5_000, 15_000, 45_000] as const;
const NATIVE_SEND_RATE_LIMIT_DELAYS = [60_000, 5 * 60_000, 15 * 60_000] as const;

export interface NativeSendFailureClass {
  kind: "http_4xx" | "http_5xx" | "timeout" | "network" | "api_ret" | "unknown";
  retryable: boolean;
  status?: number;
  apiRet?: number;
}

export function classifyNativeSendFailure(error: unknown): NativeSendFailureClass {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/\bsendMessage\s+([45]\d{2})\b/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status >= 500) return { kind: "http_5xx", retryable: true, status };
    return {
      kind: "http_4xx",
      retryable: [408, 409, 425, 429].includes(status),
      status,
    };
  }
  if (name === "AbortError" || /aborted|timeout/i.test(message)) {
    return { kind: "timeout", retryable: true };
  }
  const apiRetMatch = message.match(/\bsendMessage\s+ret=(-?\d+)/i);
  if (apiRetMatch) {
    return { kind: "api_ret", retryable: true, apiRet: Number(apiRetMatch[1]) };
  }
  if (/fetch|network|ECONN|EPIPE|ENOTFOUND|EAI_AGAIN|socket/i.test(message)) {
    return { kind: "network", retryable: true };
  }
  return { kind: "unknown", retryable: true };
}

export async function executeNativeSendRetry<T>(options: {
  send: (attempt: number) => Promise<T>;
  delays?: readonly number[];
  delay?: (milliseconds: number) => Promise<void>;
  onFailure?: (event: {
    attempt: number;
    delayMs?: number;
    failure: NativeSendFailureClass;
  }) => Promise<void> | void;
}): Promise<{ value: T; attempts: number }> {
  const delays = options.delays ?? NATIVE_SEND_RETRY_DELAYS;
  const delay = options.delay
    ?? (async (milliseconds: number) => await new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { value: await options.send(attempt), attempts: attempt };
    } catch (error) {
      const failure = classifyNativeSendFailure(error);
      const delayMs = failure.retryable
        ? (failure.apiRet === -2 ? NATIVE_SEND_RATE_LIMIT_DELAYS : delays)[attempt - 1]
        : undefined;
      await options.onFailure?.({
        attempt,
        ...(delayMs === undefined ? {} : { delayMs }),
        failure,
      });
      if (delayMs === undefined) throw error;
      await delay(delayMs);
    }
  }
}

export async function executeNativeAttachmentFirst<T>(options: {
  sendMedia: (attempt: number) => Promise<T>;
  sendCaption?: () => Promise<void>;
  delays?: readonly number[];
  delay?: (milliseconds: number) => Promise<void>;
  onMediaFailure?: (event: {
    attempt: number;
    delayMs?: number;
    failure: NativeSendFailureClass;
  }) => Promise<void> | void;
  onCaptionFailure?: (failure: NativeSendFailureClass) => Promise<void> | void;
}): Promise<{
  value: T;
  mediaAttempts: number;
  captionAttempted: boolean;
  captionSucceeded: boolean;
}> {
  const media = await executeNativeSendRetry({
    send: options.sendMedia,
    ...(options.delays ? { delays: options.delays } : {}),
    ...(options.delay ? { delay: options.delay } : {}),
    ...(options.onMediaFailure ? { onFailure: options.onMediaFailure } : {}),
  });
  let captionAttempted = false;
  let captionSucceeded = false;
  if (options.sendCaption) {
    captionAttempted = true;
    try {
      await options.sendCaption();
      captionSucceeded = true;
    } catch (error) {
      await options.onCaptionFailure?.(classifyNativeSendFailure(error));
    }
  }
  return {
    value: media.value,
    mediaAttempts: media.attempts,
    captionAttempted,
    captionSucceeded,
  };
}

function configuredUrlSource(value = process.env.WEIXIN_CDN_PRIMARY_URL_SOURCE): UploadUrlSource {
  return value?.trim().toLowerCase() === "param" ? "param" : "full";
}

async function appendDiagnostic(dataDir: string, record: Record<string, unknown>): Promise<void> {
  const logDir = path.join(dataDir, "logs");
  const logFile = path.join(logDir, "media-protocol.jsonl");
  await mkdir(logDir, { recursive: true, mode: 0o750 });
  const current = await stat(logFile).catch(() => undefined);
  if (current && current.size >= MAX_DIAGNOSTIC_BYTES) {
    await rename(logFile, `${logFile}.1`).catch(() => undefined);
  }
  await appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function safeUploadResponse(response: StreamUploadResponse): Omit<StreamUploadResponse, "downloadParam"> & {
  downloadParamPresent: boolean;
} {
  const { downloadParam, ...safe } = response;
  return { ...safe, downloadParamPresent: Boolean(downloadParam) };
}

export async function sendExactNativeFile(options: ExactNativeSendOptions): Promise<{ messageId: string }> {
  if (
    options.queueAttempt !== undefined
    && (!Number.isSafeInteger(options.queueAttempt) || options.queueAttempt < 1)
  ) {
    throw new NativeDeliveryError("WEIXIN_QUEUE_ATTEMPT_INVALID", "queue attempt must be a positive integer");
  }
  const accountFile = path.join(options.dataDir, "state", "openclaw-weixin", "accounts", `${options.accountId}.json`);
  const contextFile = path.join(
    options.dataDir,
    "state",
    "openclaw-weixin",
    "accounts",
    `${options.accountId}.context-tokens.json`,
  );
  const account = JSON.parse(await readFile(accountFile, "utf8")) as AccountRecord;
  if (!account.token || !account.baseUrl) {
    throw new NativeDeliveryError("WEIXIN_OWNER_CONTEXT_MISMATCH", "Weixin owner context does not match the configured account");
  }
  const baseUrl = account.baseUrl;
  const token = account.token;
  let contextToken = await readOwnerContextToken(contextFile, options.expectedOwner);
  const source = await verifyUploadSource(options.filePath, options.expectedSize, options.expectedSha256);
  const mediaKind = nativeMediaKind(options.fileName);
  const mediaType = mediaKind === "image" ? 1 : mediaKind === "video" ? 2 : 3;
  const preferredUrlSource = configuredUrlSource();
  const socksProxy = parseLoopbackSocksProxy(process.env.WEIXIN_CDN_SOCKS_PROXY);
  const socksAgent = socksProxy ? new SocksHttpsAgent(socksProxy) : undefined;
  const attemptTickets = new Map<number, UploadTicket>();
  const retryDelays = retryDelaysForSize(source.size);
  const maxUploadAttempts = options.maxUploadAttempts
    ?? (source.size >= 16 * 1024 * 1024 ? 6 : 4);
  if (!Number.isSafeInteger(maxUploadAttempts) || maxUploadAttempts < 1 || maxUploadAttempts > 8) {
    throw new NativeDeliveryError("WEIXIN_UPLOAD_ATTEMPTS_INVALID", "upload attempt count must be between 1 and 8");
  }
  let retryDelayIndex = 0;
  let result: Awaited<ReturnType<typeof executeUploadStrategy<UploadTicket>>>;
  try {
    result = await executeUploadStrategy<UploadTicket>({
      methods: configuredUploadMethods(
        process.env.WEIXIN_CDN_PRIMARY_METHOD,
        process.env.WEIXIN_CDN_ALTERNATE_METHOD,
        maxUploadAttempts,
      ),
      async acquire(_method, attempt) {
      // The first pass established the trusted baseline. Every retry reads the
      // file again and recomputes both digests before a new task is requested.
      const attemptSource = attempt === 1
        ? source
        : await verifyUploadSource(options.filePath, source.size, source.sha256);
      const filekey = crypto.randomBytes(16).toString("hex");
      const aeskey = crypto.randomBytes(16);
      const ciphertextSize = aesEcbPaddedSize(attemptSource.size);
      const uploadRequest = {
        filekey,
        media_type: mediaType,
        to_user_id: options.expectedOwner,
        rawsize: attemptSource.size,
        rawfilemd5: attemptSource.md5,
        filesize: ciphertextSize,
        no_need_thumb: true,
        aeskey: aeskey.toString("hex"),
      };
      const uploadUrlResponse = socksAgent
        ? await getUploadUrlThroughAgent({
            agent: socksAgent,
            baseUrl,
            token,
            body: uploadRequest,
          })
        : await getUploadUrl({
            baseUrl,
            token,
            timeoutMs: 20_000,
            ...uploadRequest,
          });
      if (typeof uploadUrlResponse.ret === "number" && uploadUrlResponse.ret !== 0) {
        throw new NativeUploadError(
          "WEIXIN_PRESIGN_FAILED",
          `Weixin getUploadUrl failed with ret=${uploadUrlResponse.ret}`,
          { attempt },
        );
      }
      const fullUrl = uploadUrlResponse.upload_full_url?.trim();
      const paramUrl = uploadUrlResponse.upload_param
        ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadUrlResponse.upload_param)}&filekey=${encodeURIComponent(filekey)}`
        : undefined;
      const rawTarget = preferredUrlSource === "full" ? fullUrl : paramUrl;
      if (!rawTarget) {
        throw new NativeUploadError(
          "WEIXIN_UPLOAD_URL_MISSING",
          `Weixin getUploadUrl returned no ${preferredUrlSource} upload target`,
          {
          attempt,
          },
        );
      }
      const ticket = {
        aeskey,
        filekey,
        source: attemptSource,
        target: assertCdnTarget(rawTarget),
        targetSource: preferredUrlSource,
      };
      attemptTickets.set(attempt, ticket);
      return ticket;
      },
      async upload(ticket, method) {
      return await uploadEncryptedFile({
        filePath: options.filePath,
        source: ticket.source,
        aesKey: ticket.aeskey,
        method,
        url: ticket.target,
        ...(socksAgent ? { agent: socksAgent } : {}),
      });
      },
      async onAttempt(event) {
      const ticket = attemptTickets.get(event.attempt);
      await appendDiagnostic(options.dataDir, {
        event: "native_upload",
        transferId: options.transferId,
        queueAttempt: options.queueAttempt,
        attempt: event.attempt,
        taskId: ticket ? taskIdFromUrl(ticket.target.href) : undefined,
        sourceSize: source.size,
        sourceSha256: source.sha256,
        ciphertextSize: aesEcbPaddedSize(source.size),
        mediaKind,
        requestMethod: event.method,
        urlSource: ticket?.targetSource,
        egressMode: socksAgent ? "loopback-socks5h" : "direct",
        contentLength: aesEcbPaddedSize(source.size),
        errorCode: event.errorCode,
        ...(event.response ? { response: safeUploadResponse(event.response) } : {}),
      });
      await options.onUploadAttempt?.({
        attempt: event.attempt,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        ...(event.response ? { status: event.response.status } : {}),
      });
      },
      async delay(defaultMilliseconds) {
      const delayMs = retryDelays[Math.min(retryDelayIndex, retryDelays.length - 1)]
        ?? defaultMilliseconds;
      retryDelayIndex += 1;
      await appendDiagnostic(options.dataDir, {
        event: "native_retry_delay",
        transferId: options.transferId,
        sourceSize: source.size,
        sourceSha256: source.sha256,
        nextAttempt: retryDelayIndex + 1,
        delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      },
    });
  } finally {
    socksAgent?.destroy();
  }
  const uploaded: UploadedFile = {
    filekey: result.ticket.filekey,
    downloadEncryptedQueryParam: result.response.downloadParam!,
    aeskey: result.ticket.aeskey.toString("hex"),
    fileSize: source.size,
    fileSizeCiphertext: aesEcbPaddedSize(source.size),
  };

  const sendOptions = {
    baseUrl,
    token,
    timeoutMs: 20_000,
  };
  let sent: { messageId: string };
  let captionSendAttempts = 0;
  let captionSendSucceeded = false;
  let mediaSendAttempts = 0;
  const media = {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
    encrypt_type: 1,
  };
  const item = mediaKind === "image"
    ? {
        type: 2,
        image_item: {
          media,
          mid_size: uploaded.fileSizeCiphertext,
        },
      }
    : mediaKind === "video"
      ? {
          type: 5,
          video_item: {
            media,
            video_size: uploaded.fileSizeCiphertext,
          },
        }
      : {
          type: 4,
          file_item: {
            media,
            file_name: options.fileName,
            len: String(uploaded.fileSize),
          },
        };
  try {
    const delivery = await executeNativeAttachmentFirst({
      sendMedia: async () => {
        // Uploads near 50 MiB can run for minutes. Always reload the token
        // immediately before every downstream attempt so an inbound message
        // received during upload or backoff refreshes the proactive-send
        // window instead of being ignored until a brand-new CDN task.
        contextToken = await readOwnerContextToken(contextFile, options.expectedOwner);
        return await sendMessageItemWeixin({
          to: options.expectedOwner,
          clientId: nativeMessageClientId(options.transferId, "media"),
          label: "sendExactNativeMedia",
          item,
          opts: { ...sendOptions, contextToken },
        });
      },
      delay: async (milliseconds) => {
        const changed = await waitForContextTokenChange({
          contextFile,
          expectedOwner: options.expectedOwner,
          previousToken: contextToken,
          milliseconds,
        });
        if (changed) {
          await appendDiagnostic(options.dataDir, {
            event: "native_sendmessage_context_refresh",
            transferId: options.transferId,
            queueAttempt: options.queueAttempt,
            delayInterrupted: true,
          });
        }
      },
      ...(options.caption
        ? {
            sendCaption: async () => {
              captionSendAttempts = 1;
              contextToken = await readOwnerContextToken(contextFile, options.expectedOwner);
              await sendMessageItemWeixin({
                to: options.expectedOwner,
                clientId: nativeMessageClientId(options.transferId, "caption"),
                label: "sendExactNativeCaption",
                item: {
                  type: 1,
                  text_item: { text: options.caption! },
                },
                opts: { ...sendOptions, contextToken },
              });
            },
          }
        : {}),
      onMediaFailure: async (event) => {
        await appendDiagnostic(options.dataDir, {
          event: "native_sendmessage_attempt",
          transferId: options.transferId,
          queueAttempt: options.queueAttempt,
          phase: "media",
          sendAttempt: event.attempt,
          retryable: event.failure.retryable,
          failureKind: event.failure.kind,
          status: event.failure.status,
          apiRet: event.failure.apiRet,
          delayMs: event.delayMs,
        });
      },
      onCaptionFailure: async (failure) => {
        await appendDiagnostic(options.dataDir, {
          event: "native_caption_failed",
          transferId: options.transferId,
          queueAttempt: options.queueAttempt,
          sendAttempt: 1,
          retryable: failure.retryable,
          failureKind: failure.kind,
          status: failure.status,
          apiRet: failure.apiRet,
          attachmentAlreadySucceeded: true,
        });
      },
    });
    mediaSendAttempts = delivery.mediaAttempts;
    captionSendSucceeded = delivery.captionSucceeded;
    sent = delivery.value;
  } catch (error) {
    const failure = classifyNativeSendFailure(error);
    await appendDiagnostic(options.dataDir, {
      event: "native_sendmessage",
      transferId: options.transferId,
      queueAttempt: options.queueAttempt,
      sourceSize: source.size,
      sourceSha256: source.sha256,
      mediaKind,
      uploadMethod: result.method,
      uploadAttempts: result.attempt,
      executed: true,
      success: false,
      errorCode: "WEIXIN_SEND_FAILED",
      captionSendAttempts,
      mediaSendAttempts,
      finalFailureKind: failure.kind,
      finalFailureStatus: failure.status,
      finalFailureApiRet: failure.apiRet,
    });
    throw new NativeDeliveryError("WEIXIN_SEND_FAILED", "Weixin sendMessage failed after a successful CDN upload", {
      cause: error,
    });
  }
  await appendDiagnostic(options.dataDir, {
    event: "native_sendmessage",
    transferId: options.transferId,
    queueAttempt: options.queueAttempt,
    sourceSize: source.size,
    sourceSha256: source.sha256,
    mediaKind,
    uploadMethod: result.method,
    uploadUrlSource: result.ticket.targetSource,
    uploadAttempts: result.attempt,
    captionSendAttempts,
    captionSendSucceeded,
    mediaSendAttempts,
    executed: true,
    success: true,
  });
  return sent;
}
