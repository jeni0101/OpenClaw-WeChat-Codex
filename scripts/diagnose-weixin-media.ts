import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getUploadUrl } from "@tencent-weixin/openclaw-weixin/dist/src/api/api.js";
import { uploadFileAttachmentToWeixin } from "@tencent-weixin/openclaw-weixin/dist/src/cdn/upload.js";
import { sendFileMessageWeixin } from "@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js";

const projectRoot = process.env.WECHAT_CLAWBOT_ROOT ?? "/opt/WeChat-Open in";
const dataDir = process.env.WECHAT_CLAWBOT_DATA ?? path.join(projectRoot, "data");
const accountId = process.env.WECHAT_MEDIA_ACCOUNT_ID?.trim() ?? "";
if (!accountId) throw new Error("WECHAT_MEDIA_ACCOUNT_ID is required");
const accountFile = path.join(dataDir, "state", "openclaw-weixin", "accounts", `${accountId}.json`);
const contextFile = path.join(dataDir, "state", "openclaw-weixin", "accounts", `${accountId}.context-tokens.json`);
const matrixDir = process.argv[2] ?? path.join(dataDir, "tmp", "weixin-media-matrix");
const outputFile = process.argv[3] ?? path.join(dataDir, "reports", "weixin-media-protocol-matrix.jsonl");
const includeAllPptx = process.env.WEIXIN_DIAG_ALL_PPTX === "1";
const exactFixture = process.env.WEIXIN_DIAG_FIXTURE?.trim();
const sendOnUploadSuccess = process.env.WEIXIN_DIAG_SEND_SUCCESS === "1";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const allVariants = [
  "official-plugin",
  "openilink-sdk",
  "raw-fixed",
  "raw-stream",
  "fresh-task",
  "fixed-post-full",
  "fixed-put-full",
  "fixed-post-param",
  "fixed-put-param",
  "legacy2110-post-full",
  "pinned-post-full",
  "freshconn-post-full",
  "expect-post-full",
  "curl-post-full",
  "derived-post-param",
  "derived-put-param",
] as const;
type Variant = (typeof allVariants)[number];
const requestedVariants = (process.env.WEIXIN_DIAG_VARIANTS ?? allVariants.join(","))
  .split(",")
  .map((value) => value.trim())
  .filter((value): value is Variant => (allVariants as readonly string[]).includes(value));
if (requestedVariants.length === 0) throw new Error("no valid diagnostic variants selected");
const variants: Variant[] = requestedVariants;
const pinnedCdnIp = process.env.WEIXIN_DIAG_CDN_IP?.trim();
if (variants.includes("pinned-post-full") && (!pinnedCdnIp || !net.isIPv4(pinnedCdnIp))) {
  throw new Error("WEIXIN_DIAG_CDN_IP must be a valid IPv4 address for pinned-post-full");
}
const uploadDelayMs = Number(process.env.WEIXIN_DIAG_UPLOAD_DELAY_MS ?? "0");
if (!Number.isSafeInteger(uploadDelayMs) || uploadDelayMs < 0 || uploadDelayMs > 60_000) {
  throw new Error("WEIXIN_DIAG_UPLOAD_DELAY_MS must be an integer between 0 and 60000");
}
const diagnosticMediaType = Number(process.env.WEIXIN_DIAG_MEDIA_TYPE ?? "3");
if (![1, 2, 3, 4].includes(diagnosticMediaType)) {
  throw new Error("WEIXIN_DIAG_MEDIA_TYPE must be one of 1, 2, 3 or 4");
}
const curlProxy = process.env.WEIXIN_DIAG_CURL_PROXY?.trim();
if (curlProxy) {
  const parsedProxy = new URL(curlProxy);
  if (
    !["socks5:", "socks5h:"].includes(parsedProxy.protocol)
    || !["127.0.0.1", "[::1]"].includes(parsedProxy.hostname)
    || !parsedProxy.port
    || parsedProxy.username
    || parsedProxy.password
  ) {
    throw new Error("WEIXIN_DIAG_CURL_PROXY must be an unauthenticated loopback SOCKS5 URL");
  }
}
const forcedRepetitions = process.env.WEIXIN_DIAG_REPETITIONS === undefined
  ? undefined
  : Number(process.env.WEIXIN_DIAG_REPETITIONS);
if (
  forcedRepetitions !== undefined
  && (!Number.isSafeInteger(forcedRepetitions) || forcedRepetitions < 1 || forcedRepetitions > 10)
) {
  throw new Error("WEIXIN_DIAG_REPETITIONS must be an integer between 1 and 10");
}

interface AccountRecord {
  token?: string;
  baseUrl?: string;
}

interface UploadUrlResponse {
  ret?: number;
  errmsg?: string;
  upload_param?: string;
  upload_full_url?: string;
}

interface TraceRecord {
  at: string;
  event: string;
  [key: string]: unknown;
}

interface MatrixResult {
  fixture: string;
  variant: Variant;
  repetition: number;
  sourceSize: number;
  status: "success" | "failed";
}

interface SupportAttempt {
  at: string;
  fixture: string;
  repetition: number;
  method: "POST" | "PUT";
  urlSource: "full" | "param" | "derived-param";
  taskId?: string;
  status: number;
  elapsedMs: number;
  downloadParamPresent: boolean;
}

interface UploadResult {
  status: number;
  responseHeaders: Record<string, unknown>;
  responseBytes: number;
  responseSha256: string;
  errorBodyPreview?: string;
  timingsMs: Record<string, number>;
  tls?: Record<string, unknown>;
  downloadParam?: string;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tag(value: string): string {
  return sha256(value).slice(0, 12);
}

function elapsed(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100;
}

function safeUrl(raw: string): Record<string, unknown> {
  try {
    const url = new URL(raw);
    const taskId = url.searchParams.get("taskid");
    return {
      protocol: url.protocol,
      host: url.host,
      path: url.pathname,
      queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
      taskId: taskId && /^[A-Za-z0-9_-]{1,128}$/.test(taskId) ? taskId : undefined,
      urlTag: tag(raw),
    };
  } catch {
    return { invalid: true, urlTag: tag(raw) };
  }
}

function safeHeaders(headers: Headers | Record<string, string | string[] | undefined>): Record<string, unknown> {
  const entries: Array<[string, string]> = headers instanceof Headers
    ? [...headers.entries()]
    : Object.entries(headers).flatMap(([name, value]) => {
      if (value === undefined) return [];
      return [[name, Array.isArray(value) ? value.join(",") : value] as [string, string]];
    });
  const safeValue = new Set([
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
    "x-cache-lookup",
  ]);
  const result: Record<string, unknown> = {};
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (name === "x-encrypted-param") {
      result[name] = { present: true, length: value.length, tag: tag(value) };
    } else if (safeValue.has(name)) {
      result[name] = value.slice(0, 256);
    }
  }
  return result;
}

function safeError(error: unknown): string {
  const cause = error && typeof error === "object" && "cause" in error
    ? ` cause=${String((error as { cause?: unknown }).cause)}`
    : "";
  return `${String(error)}${cause}`
    .replace(/https?:\/\/\S+/gi, "<redacted-url>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "<redacted-secret>")
    .slice(0, 500);
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

async function legacy2110GetUploadUrl(params: {
  baseUrl: string;
  token: string;
  body: Record<string, unknown>;
}): Promise<UploadUrlResponse> {
  const target = new URL("ilink/bot/getuploadurl", params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`);
  if (target.protocol !== "https:" || target.hostname !== "ilinkai.weixin.qq.com") {
    throw new Error("legacy getuploadurl target is not the official iLink API");
  }
  const body = Buffer.from(JSON.stringify(params.body));
  return await new Promise<UploadUrlResponse>((resolve, reject) => {
    const request = https.request(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${params.token}`,
        "X-WECHAT-UIN": randomWechatUin(),
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": String((2 << 16) | (1 << 8) | 10),
      },
      timeout: 20_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes <= 64 * 1024) chunks.push(buffer);
        else request.destroy(new Error("legacy getuploadurl response exceeded 64 KiB"));
      });
      response.once("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode !== 200) {
          reject(new Error(`legacy getuploadurl HTTP ${response.statusCode ?? 0}`));
          return;
        }
        try {
          resolve(JSON.parse(raw) as UploadUrlResponse);
        } catch (error) {
          reject(new Error("legacy getuploadurl returned invalid JSON", { cause: error }));
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("legacy getuploadurl timeout")));
    request.once("error", reject);
    request.end(body);
  });
}

function repetitionsFor(size: number): number {
  if (forcedRepetitions !== undefined) return forcedRepetitions;
  if (size <= 96 * 1024) return 3;
  if (size >= 1_300_000 && size <= 2 * 1024 * 1024) return 5;
  if (size >= 15 * 1024 * 1024) return 3;
  return 1;
}

function requiredAcceptanceRuns(size: number): number | undefined {
  if (size <= 96 * 1024) return 3;
  if (size >= 1_300_000 && size <= 2 * 1024 * 1024) return 5;
  if (size >= 15 * 1024 * 1024) return 3;
  return undefined;
}

await mkdir(path.dirname(outputFile), { recursive: true, mode: 0o750 });
await writeFile(outputFile, "", { mode: 0o600 });
const matrixResults: MatrixResult[] = [];
const supportAttempts: SupportAttempt[] = [];

async function trace(record: TraceRecord): Promise<void> {
  await appendFile(outputFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

const account = JSON.parse(await readFile(accountFile, "utf8")) as AccountRecord;
const contextTokens = JSON.parse(await readFile(contextFile, "utf8")) as Record<string, string>;
const ownerEntries = Object.entries(contextTokens).filter(([owner, token]) => owner && token);
if (!account.token || !account.baseUrl) throw new Error("Weixin account credential is incomplete");
if (ownerEntries.length !== 1) throw new Error(`expected exactly one owner context, found ${ownerEntries.length}`);
const [ownerId, contextToken] = ownerEntries[0]!;
const token = account.token;
const baseUrl = account.baseUrl;

const originalFetch = globalThis.fetch;
let currentTest: { fixture: string; variant: Variant; repetition: number } | undefined;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const started = performance.now();
  const requestHeaders = new Headers(init?.headers);
  const requestBodyLength =
    typeof init?.body === "string"
      ? Buffer.byteLength(init.body)
      : init?.body instanceof Uint8Array
        ? init.body.byteLength
        : undefined;
  try {
    const response = await originalFetch(input, init);
    await trace({
      at: new Date().toISOString(),
      event: "fetch",
      test: currentTest,
      request: {
        ...safeUrl(rawUrl),
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        contentLength: requestHeaders.get("content-length") ?? requestBodyLength,
        transferEncoding: requestHeaders.get("transfer-encoding") ?? undefined,
      },
      response: {
        status: response.status,
        headers: safeHeaders(response.headers),
      },
      elapsedMs: elapsed(started),
    });
    return response;
  } catch (error) {
    await trace({
      at: new Date().toISOString(),
      event: "fetch_error",
      test: currentTest,
      request: {
        ...safeUrl(rawUrl),
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        contentLengthHeader: requestHeaders.get("content-length") ?? undefined,
        computedBodyLength: requestBodyLength,
      },
      elapsedMs: elapsed(started),
      error: safeError(error),
    });
    throw error;
  }
};

async function freshUploadTarget(
  plaintext: Buffer,
  profile: "current" | "legacy2110" | "curlproxy" = "current",
): Promise<{
  url: string;
  fullUrl?: string;
  paramUrl?: string;
  derivedParamUrl?: string;
  filekey: string;
  aeskey: Buffer;
  ciphertext: Buffer;
}> {
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-ecb", aeskey, null);
  cipher.setAutoPadding(true);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const requestBody = {
    filekey,
    media_type: diagnosticMediaType,
    to_user_id: ownerId,
    rawsize: plaintext.byteLength,
    rawfilemd5: crypto.createHash("md5").update(plaintext).digest("hex"),
    filesize: ciphertext.byteLength,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  };
  const response = profile === "legacy2110"
    ? await legacy2110GetUploadUrl({
        baseUrl,
        token,
        body: {
          ...requestBody,
          base_info: { channel_version: "2.1.10" },
        },
      })
    : profile === "curlproxy"
      ? await curlProxyGetUploadUrl({
          ...requestBody,
          base_info: {
            channel_version: "2.4.6",
            bot_agent: "OpenClaw",
          },
        })
      : await getUploadUrl({
          baseUrl,
          token,
          timeoutMs: 20_000,
          ...requestBody,
        });
  if (typeof response.ret === "number" && response.ret !== 0) {
    throw new Error(`${profile} getUploadUrl ret=${response.ret}`);
  }
  const fullUrl = response.upload_full_url?.trim() || undefined;
  const paramUrl = response.upload_param
    ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(response.upload_param)}&filekey=${encodeURIComponent(filekey)}`
    : undefined;
  const fullTarget = fullUrl ? new URL(fullUrl) : undefined;
  const fullEncryptedParam = fullTarget?.searchParams.get("encrypted_query_param");
  const fullFilekey = fullTarget?.searchParams.get("filekey");
  const derivedParamUrl = fullEncryptedParam && fullFilekey === filekey
    ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(fullEncryptedParam)}&filekey=${encodeURIComponent(filekey)}`
    : undefined;
  const url = fullUrl || paramUrl || "";
  await trace({
    at: new Date().toISOString(),
    event: "getuploadurl_result",
    test: currentTest,
    request: {
      mediaType: diagnosticMediaType,
      profile,
      rawSize: plaintext.byteLength,
      ciphertextSize: ciphertext.byteLength,
      fileSha256: sha256(plaintext),
      ownerTag: tag(ownerId),
      filekeyTag: tag(filekey),
    },
    response: {
      hasFullUrl: Boolean(response.upload_full_url),
      uploadParam: response.upload_param
        ? { present: true, length: response.upload_param.length, tag: tag(response.upload_param) }
        : { present: false },
      fullTarget: fullUrl ? safeUrl(fullUrl) : { missing: true },
      paramTarget: paramUrl ? safeUrl(paramUrl) : { missing: true },
      derivedParamTarget: derivedParamUrl ? safeUrl(derivedParamUrl) : { missing: true },
    },
  });
  if (!url) throw new Error("getUploadUrl returned no upload target");
  return {
    url,
    ...(fullUrl ? { fullUrl } : {}),
    ...(paramUrl ? { paramUrl } : {}),
    ...(derivedParamUrl ? { derivedParamUrl } : {}),
    filekey,
    aeskey,
    ciphertext,
  };
}

async function rawHttpsUpload(
  url: string,
  body: Buffer,
  options: {
    streaming: boolean;
    method: "POST" | "PUT";
    forcedAddress?: string;
    freshConnection?: boolean;
    expectContinue?: boolean;
  },
): Promise<UploadResult> {
  return await new Promise<UploadResult>((resolve, reject) => {
    const started = performance.now();
    const marks: Record<string, number> = {};
    let tls: Record<string, unknown> | undefined;
    const pinnedLookup: https.RequestOptions["lookup"] = options.forcedAddress
      ? (_hostname, lookupOptions, callback) => {
          if (typeof lookupOptions === "object" && lookupOptions.all) {
            (callback as unknown as (
              error: NodeJS.ErrnoException | null,
              addresses: Array<{ address: string; family: number }>,
            ) => void)(null, [{ address: options.forcedAddress!, family: 4 }]);
            return;
          }
          (callback as unknown as (
            error: NodeJS.ErrnoException | null,
            address: string,
            family: number,
          ) => void)(null, options.forcedAddress!, 4);
        }
      : undefined;
    const request = https.request(url, {
      method: options.method,
      headers: {
        "Content-Type": "application/octet-stream",
        ...(options.streaming ? {} : { "Content-Length": String(body.byteLength) }),
        ...(options.freshConnection ? { Connection: "close" } : {}),
        ...(options.expectContinue ? { Expect: "100-continue" } : {}),
      },
      timeout: 180_000,
      ...(options.freshConnection ? { agent: false } : {}),
      ...(pinnedLookup ? { lookup: pinnedLookup } : {}),
    }, (response) => {
      marks.firstByte = elapsed(started);
      const responseHash = crypto.createHash("sha256");
      const previewChunks: Buffer[] = [];
      let previewBytes = 0;
      let responseBytes = 0;
      response.on("data", (chunk) => {
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
        marks.complete = elapsed(started);
        const responseBody = Buffer.concat(previewChunks);
        const errorBodyPreview = responseBody.length > 0
          ? safeError(responseBody.toString("utf8"))
          : undefined;
        const result: UploadResult = {
          status: response.statusCode ?? 0,
          responseHeaders: safeHeaders(response.headers),
          responseBytes,
          responseSha256: responseHash.digest("hex"),
          timingsMs: marks,
          ...(errorBodyPreview ? { errorBodyPreview } : {}),
          ...(typeof response.headers["x-encrypted-param"] === "string"
            ? { downloadParam: response.headers["x-encrypted-param"] }
            : {}),
          ...(tls ? { tls } : {}),
        };
        if (result.status !== 200) request.destroy();
        resolve(result);
      });
    });
    request.once("socket", (socket) => {
      marks.socket = elapsed(started);
      socket.once("lookup", () => { marks.dns = elapsed(started); });
      socket.once("connect", () => { marks.connect = elapsed(started); });
      socket.once("secureConnect", () => {
        marks.tls = elapsed(started);
        const secureSocket = socket as import("node:tls").TLSSocket;
        tls = {
          protocol: secureSocket.getProtocol(),
          cipher: secureSocket.getCipher()?.name,
          authorized: secureSocket.authorized,
          remoteFamily: secureSocket.remoteFamily,
          remoteAddressTag: secureSocket.remoteAddress ? tag(secureSocket.remoteAddress) : undefined,
        };
      });
      // A CDN edge can close a chunked upload before the client finishes
      // writing. The request-level error is authoritative; consume the socket
      // event so it cannot terminate the whole matrix process.
      socket.on("error", () => undefined);
    });
    request.once("timeout", () => request.destroy(new Error("CDN request timeout")));
    request.once("error", reject);
    const sendBody = () => {
      if (request.destroyed) return;
      if (options.streaming) {
        const chunkBytes = 64 * 1024;
        for (let offset = 0; offset < body.byteLength; offset += chunkBytes) {
          if (request.destroyed) break;
          request.write(body.subarray(offset, Math.min(offset + chunkBytes, body.byteLength)));
        }
        request.end();
      } else {
        request.end(body);
      }
    };
    if (options.expectContinue) {
      request.once("continue", () => {
        marks.continue = elapsed(started);
        sendBody();
      });
      request.flushHeaders();
    } else {
      sendBody();
    }
  });
}

async function curlHttpsUpload(url: string, body: Buffer): Promise<UploadResult> {
  const temporaryRoot = path.join(dataDir, "tmp");
  await mkdir(temporaryRoot, { recursive: true, mode: 0o750 });
  const temporaryDir = await mkdtemp(path.join(temporaryRoot, "curl-cdn-upload-"));
  const bodyFile = path.join(temporaryDir, "ciphertext.bin");
  await writeFile(bodyFile, body, { mode: 0o600 });
  try {
    return await new Promise<UploadResult>((resolve, reject) => {
    const marker = "__WEIXIN_CURL__";
    const child = spawn("curl", [
      "--silent",
      "--show-error",
      "--http1.1",
      ...(curlProxy ? [] : ["--noproxy", "*"]),
      "--config",
      "-",
      "--data-binary",
      `@${bodyFile}`,
      "--dump-header",
      "-",
      "--output",
      "/dev/null",
      "--write-out",
      `\\n${marker}:%{http_code}|%{time_connect}|%{time_appconnect}|%{time_starttransfer}|%{time_total}`,
    ]);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      const buffer = Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes <= 64 * 1024) stdoutChunks.push(buffer);
      else child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const buffer = Buffer.from(chunk);
      stderrBytes += buffer.length;
      if (stderrBytes <= 8 * 1024) stderrChunks.push(buffer);
    });
    child.stdin.on("error", () => undefined);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("latin1");
      const timingMatch = stdout.match(new RegExp(
        `${marker}:(\\d{3})\\|([0-9.]+)\\|([0-9.]+)\\|([0-9.]+)\\|([0-9.]+)`,
      ));
      if (!timingMatch) {
        reject(new Error(
          `curl upload failed exit=${code ?? "?"} signal=${signal ?? "-"} error=${safeError(Buffer.concat(stderrChunks).toString("utf8"))}`,
        ));
        return;
      }
      const headerText = stdout.slice(0, timingMatch.index);
      const responseBlocks = headerText.split(/\r?\n\r?\n/).filter((block) => /^HTTP\//i.test(block.trim()));
      const finalHeaders = responseBlocks.at(-1) ?? "";
      const header = (name: string): string | undefined => {
        const match = finalHeaders.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
        return match?.[1]?.trim();
      };
      const downloadParam = header("x-encrypted-param");
      const responseHeaders: Record<string, unknown> = {};
      for (const name of ["date", "content-length", "content-type", "server"]) {
        const value = header(name);
        if (value) responseHeaders[name] = value.slice(0, 256);
      }
      if (downloadParam) {
        responseHeaders["x-encrypted-param"] = {
          present: true,
          length: downloadParam.length,
          tag: tag(downloadParam),
        };
      }
      resolve({
        status: Number(timingMatch[1]),
        responseHeaders,
        responseBytes: 0,
        responseSha256: crypto.createHash("sha256").digest("hex"),
        timingsMs: {
          connect: Number(timingMatch[2]) * 1_000,
          tls: Number(timingMatch[3]) * 1_000,
          firstByte: Number(timingMatch[4]) * 1_000,
          complete: Number(timingMatch[5]) * 1_000,
        },
        ...(downloadParam ? { downloadParam } : {}),
      });
    });
    const safeQuotedUrl = url.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const curlConfig = [
      `url = "${safeQuotedUrl}"`,
      'request = "POST"',
      'header = "Content-Type: application/octet-stream"',
      `header = "Content-Length: ${body.byteLength}"`,
      'header = "Expect:"',
      "connect-timeout = 30",
      `max-time = ${Math.max(
        120,
        Math.min(1_800, Math.ceil(body.byteLength / (32 * 1024)) + 120),
      )}`,
      ...(curlProxy ? [`proxy = "${curlProxy}"`] : []),
      ...(pinnedCdnIp
        ? [`connect-to = "novac2c.cdn.weixin.qq.com:443:${pinnedCdnIp}:443"`]
        : []),
      "",
    ].join("\n");
    child.stdin.end(curlConfig);
    });
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function curlProxyGetUploadUrl(body: Record<string, unknown>): Promise<UploadUrlResponse> {
  if (!curlProxy) throw new Error("curl proxy is not configured");
  const temporaryRoot = path.join(dataDir, "tmp");
  await mkdir(temporaryRoot, { recursive: true, mode: 0o750 });
  const temporaryDir = await mkdtemp(path.join(temporaryRoot, "curl-ilink-presign-"));
  const bodyFile = path.join(temporaryDir, "request.json");
  const requestBody = Buffer.from(JSON.stringify(body), "utf8");
  await writeFile(bodyFile, requestBody, { mode: 0o600 });
  const quote = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    return await new Promise<UploadUrlResponse>((resolve, reject) => {
      const marker = "__WEIXIN_PRESIGN__";
      const child = spawn("curl", [
        "--silent",
        "--show-error",
        "--http1.1",
        "--config",
        "-",
        "--data-binary",
        `@${bodyFile}`,
        "--output",
        "-",
        "--write-out",
        `\\n${marker}:%{http_code}|%{time_total}`,
      ]);
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        const buffer = Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes <= 128 * 1024) stdoutChunks.push(buffer);
        else child.kill();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.concat(stderrChunks).length < 8 * 1024) stderrChunks.push(Buffer.from(chunk));
      });
      child.stdin.on("error", () => undefined);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const match = stdout.match(new RegExp(`\\n${marker}:(\\d{3})\\|([0-9.]+)\\s*$`));
        if (!match || match.index === undefined) {
          reject(new Error(
            `proxied presign failed exit=${code ?? "?"} signal=${signal ?? "-"} error=${safeError(Buffer.concat(stderrChunks).toString("utf8"))}`,
          ));
          return;
        }
        const status = Number(match[1]);
        if (status !== 200) {
          reject(new Error(`proxied presign returned HTTP ${status}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.slice(0, match.index)) as UploadUrlResponse);
        } catch (error) {
          reject(new Error("proxied presign returned invalid JSON", { cause: error }));
        }
      });
      const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
      const endpoint = new URL("ilink/bot/getuploadurl", base).href;
      const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
      child.stdin.end([
        `url = "${quote(endpoint)}"`,
        'request = "POST"',
        `proxy = "${quote(curlProxy)}"`,
        'header = "Content-Type: application/json"',
        'header = "AuthorizationType: ilink_bot_token"',
        `header = "Authorization: Bearer ${quote(token.trim())}"`,
        `header = "X-WECHAT-UIN: ${uin}"`,
        'header = "iLink-App-Id: bot"',
        'header = "iLink-App-ClientVersion: 132102"',
        "connect-timeout = 30",
        "max-time = 30",
        "",
      ].join("\n"));
    });
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

type OpenIlinkModule = {
  Client: new (token: string, config: Record<string, unknown>) => {
    uploadFile(data: Buffer, to: string, mediaType: number): Promise<{
      file_key: string;
      download_encrypted_query_param: string;
      aes_key: string;
      file_size: number;
      ciphertext_size: number;
    }>;
  };
  MEDIA_FILE: number;
};

const openIlinkEntry = path.join(
  dataDir,
  "tools",
  "openilink-sdk-node",
  "node_modules",
  "@openilink",
  "openilink-sdk-node",
  "dist",
  "index.js",
);
const openIlink = variants.includes("openilink-sdk")
  ? await import(pathToFileURL(openIlinkEntry).href) as OpenIlinkModule
  : undefined;

const fixtures = (await readdir(matrixDir))
  .filter((name) => includeAllPptx ? name.toLowerCase().endsWith(".pptx") : /^matrix-\d+k\.pptx$/.test(name))
  .filter((name) => !exactFixture || name === exactFixture)
  .sort((left, right) => includeAllPptx
    ? left.localeCompare(right, "zh-CN")
    : Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]));
if (fixtures.length === 0) {
  throw new Error(exactFixture
    ? `diagnostic fixture not found: ${exactFixture}`
    : "no diagnostic PPTX fixtures found");
}

await trace({
  at: new Date().toISOString(),
  event: "matrix_start",
  accountTag: tag(accountId),
  ownerTag: tag(ownerId),
  variants,
  fixtureCount: fixtures.length,
  sendOnUploadSuccess,
});

for (const fixture of fixtures) {
  const filePath = path.join(matrixDir, fixture);
  const plaintext = await readFile(filePath);
  const metadata = await stat(filePath);
  for (const variant of variants) {
    const repetitions = repetitionsFor(metadata.size);
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      currentTest = { fixture, variant, repetition };
      const started = performance.now();
      try {
        let sendMessageExecuted = false;
        if (variant === "official-plugin") {
        const uploaded = await uploadFileAttachmentToWeixin({
          filePath,
          fileName: fixture,
          toUserId: ownerId,
          opts: { baseUrl, token, timeoutMs: 20_000 },
          cdnBaseUrl: CDN_BASE_URL,
        });
        if (sendOnUploadSuccess) {
          await sendFileMessageWeixin({
            to: ownerId,
            text: "",
            fileName: fixture,
            uploaded,
            opts: {
              baseUrl,
              token,
              timeoutMs: 20_000,
              contextToken,
            },
          });
          sendMessageExecuted = true;
        }
        } else if (variant === "openilink-sdk") {
        // OpeniLink SDK 0.6.0 sets Content-Length itself. Node 24's fetch
        // rejects that otherwise correct header as a forbidden/invalid fetch
        // header before any network request. Its documented fetch injection
        // point is used to let Undici calculate the same wire length.
        const node24FetchAdapter = async (
          input: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response> => {
          const headers = new Headers(init?.headers);
          headers.delete("content-length");
          return await globalThis.fetch(input, { ...init, headers });
        };
        const client = new (openIlink!).Client(token, {
          base_url: baseUrl,
          cdn_base_url: CDN_BASE_URL,
          version: "2.4.6",
          fetch_impl: node24FetchAdapter,
        });
        const sdkUploaded = await client.uploadFile(plaintext, ownerId, openIlink!.MEDIA_FILE);
        if (sendOnUploadSuccess) {
          await sendFileMessageWeixin({
            to: ownerId,
            text: "",
            fileName: fixture,
            uploaded: {
              filekey: sdkUploaded.file_key,
              downloadEncryptedQueryParam: sdkUploaded.download_encrypted_query_param,
              aeskey: sdkUploaded.aes_key,
              fileSize: sdkUploaded.file_size,
              fileSizeCiphertext: sdkUploaded.ciphertext_size,
            },
            opts: {
              baseUrl,
              token,
              timeoutMs: 20_000,
              contextToken,
            },
          });
          sendMessageExecuted = true;
        }
        } else if (variant === "fresh-task") {
        let uploaded:
          | {
              filekey: string;
              downloadEncryptedQueryParam: string;
              aeskey: string;
              fileSize: number;
              fileSizeCiphertext: number;
            }
          | undefined;
        let lastStatus = 0;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const target = await freshUploadTarget(plaintext);
          const result = await rawHttpsUpload(target.url, target.ciphertext, {
            streaming: false,
            method: "POST",
          });
          const { downloadParam, ...safeResult } = result;
          lastStatus = result.status;
          await trace({
            at: new Date().toISOString(),
            event: "fresh_task_upload_result",
            test: currentTest,
            attempt,
            request: {
              method: "POST",
              contentLength: target.ciphertext.byteLength,
              ciphertextSize: target.ciphertext.byteLength,
              target: safeUrl(target.url),
            },
            response: safeResult,
          });
          if (result.status === 200 && downloadParam) {
            uploaded = {
              filekey: target.filekey,
              downloadEncryptedQueryParam: downloadParam,
              aeskey: target.aeskey.toString("hex"),
              fileSize: plaintext.byteLength,
              fileSizeCiphertext: target.ciphertext.byteLength,
            };
            break;
          }
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        if (!uploaded) throw new Error(`fresh-task CDN upload status=${lastStatus}`);
        if (sendOnUploadSuccess) {
          await sendFileMessageWeixin({
            to: ownerId,
            text: "",
            fileName: fixture,
            uploaded,
            opts: {
              baseUrl,
              token,
              timeoutMs: 20_000,
              contextToken,
            },
          });
          sendMessageExecuted = true;
        }
        } else if (variant === "legacy2110-post-full") {
          const target = await freshUploadTarget(plaintext, "legacy2110");
          if (!target.fullUrl) throw new Error("legacy 2.1.10 getUploadUrl did not return a full target");
          const result = await rawHttpsUpload(target.fullUrl, target.ciphertext, {
            streaming: false,
            method: "POST",
          });
          const targetInfo = safeUrl(target.fullUrl);
          supportAttempts.push({
            at: new Date().toISOString(),
            fixture,
            repetition,
            method: "POST",
            urlSource: "full",
            ...(typeof targetInfo.taskId === "string" ? { taskId: targetInfo.taskId } : {}),
            status: result.status,
            elapsedMs: result.timingsMs.complete ?? result.timingsMs.firstByte ?? 0,
            downloadParamPresent: Boolean(result.downloadParam),
          });
          const { downloadParam: _downloadParam, ...safeResult } = result;
          await trace({
            at: new Date().toISOString(),
            event: "legacy2110_upload_result",
            test: currentTest,
            request: {
              method: "POST",
              profile: "legacy2110",
              urlSource: "full",
              contentLength: target.ciphertext.byteLength,
              ciphertextSize: target.ciphertext.byteLength,
              target: targetInfo,
            },
            response: {
              ...safeResult,
              downloadParamPresent: Boolean(result.downloadParam),
            },
          });
          if (result.status !== 200 || !result.downloadParam) {
            throw new Error(`legacy 2.1.10 POST full CDN upload status=${result.status}`);
          }
        } else if (variant === "pinned-post-full") {
          const target = await freshUploadTarget(plaintext);
          if (!target.fullUrl) throw new Error("getUploadUrl did not return a full target");
          if (uploadDelayMs > 0) {
            await trace({
              at: new Date().toISOString(),
              event: "upload_delay",
              test: currentTest,
              delayMs: uploadDelayMs,
            });
            await new Promise((resolve) => setTimeout(resolve, uploadDelayMs));
          }
          const result = await rawHttpsUpload(target.fullUrl, target.ciphertext, {
            streaming: false,
            method: "POST",
            forcedAddress: pinnedCdnIp!,
          });
          const targetInfo = safeUrl(target.fullUrl);
          supportAttempts.push({
            at: new Date().toISOString(),
            fixture,
            repetition,
            method: "POST",
            urlSource: "full",
            ...(typeof targetInfo.taskId === "string" ? { taskId: targetInfo.taskId } : {}),
            status: result.status,
            elapsedMs: result.timingsMs.complete ?? result.timingsMs.firstByte ?? 0,
            downloadParamPresent: Boolean(result.downloadParam),
          });
          const { downloadParam: _downloadParam, ...safeResult } = result;
          await trace({
            at: new Date().toISOString(),
            event: "pinned_upload_result",
            test: currentTest,
            request: {
              method: "POST",
              urlSource: "full",
              pinnedAddressTag: tag(pinnedCdnIp!),
              contentLength: target.ciphertext.byteLength,
              ciphertextSize: target.ciphertext.byteLength,
              target: targetInfo,
            },
            response: {
              ...safeResult,
              downloadParamPresent: Boolean(result.downloadParam),
            },
          });
          if (result.status !== 200 || !result.downloadParam) {
            throw new Error(`pinned POST full CDN upload status=${result.status}`);
          }
        } else if (
          variant === "fixed-post-full"
          || variant === "fixed-put-full"
          || variant === "fixed-post-param"
          || variant === "fixed-put-param"
          || variant === "freshconn-post-full"
          || variant === "expect-post-full"
          || variant === "curl-post-full"
          || variant === "derived-post-param"
          || variant === "derived-put-param"
        ) {
          const target = await freshUploadTarget(
            plaintext,
            variant === "curl-post-full" && curlProxy ? "curlproxy" : "current",
          );
          const method = variant.includes("-put-") ? "PUT" : "POST";
          const urlSource = variant.startsWith("derived-")
            ? "derived-param"
            : variant.endsWith("-param")
              ? "param"
              : "full";
          const selectedUrl = urlSource === "derived-param"
            ? target.derivedParamUrl
            : urlSource === "param"
              ? target.paramUrl
              : target.fullUrl;
          if (!selectedUrl) throw new Error(`getUploadUrl did not return the requested ${urlSource} target`);
          const result = variant === "curl-post-full"
            ? await curlHttpsUpload(selectedUrl, target.ciphertext)
            : await rawHttpsUpload(selectedUrl, target.ciphertext, {
                streaming: false,
                method,
                freshConnection: variant === "freshconn-post-full",
                expectContinue: variant === "expect-post-full",
              });
          const targetInfo = safeUrl(selectedUrl);
          supportAttempts.push({
            at: new Date().toISOString(),
            fixture,
            repetition,
            method,
            urlSource,
            ...(typeof targetInfo.taskId === "string" ? { taskId: targetInfo.taskId } : {}),
            status: result.status,
            elapsedMs: result.timingsMs.complete ?? result.timingsMs.firstByte ?? 0,
            downloadParamPresent: Boolean(result.downloadParam),
          });
          const { downloadParam: _downloadParam, ...safeResult } = result;
          await trace({
            at: new Date().toISOString(),
            event: "fixed_upload_result",
            test: currentTest,
            request: {
              method,
              urlSource,
              freshConnection: variant === "freshconn-post-full",
              expectContinue: variant === "expect-post-full",
              client: variant === "curl-post-full" ? "curl-http1.1" : "node-https",
              viaLoopbackProxy: variant === "curl-post-full" && Boolean(curlProxy),
              ...(variant === "curl-post-full" && pinnedCdnIp
                ? { pinnedAddressTag: tag(pinnedCdnIp) }
                : {}),
              contentLength: target.ciphertext.byteLength,
              ciphertextSize: target.ciphertext.byteLength,
              target: safeUrl(selectedUrl),
            },
            response: {
              ...safeResult,
              downloadParamPresent: Boolean(result.downloadParam),
            },
          });
          if (result.status !== 200 || !result.downloadParam) {
            throw new Error(`fixed ${method} ${urlSource} CDN upload status=${result.status}`);
          }
        } else {
        const target = await freshUploadTarget(plaintext);
        const result = await rawHttpsUpload(target.url, target.ciphertext, {
          streaming: variant === "raw-stream",
          method: "POST",
        });
        const { downloadParam: _downloadParam, ...safeResult } = result;
        await trace({
          at: new Date().toISOString(),
          event: "raw_upload_result",
          test: currentTest,
          request: {
            method: "POST",
            contentLength: variant === "raw-fixed" ? target.ciphertext.byteLength : undefined,
            transferEncoding: variant === "raw-stream" ? "chunked" : undefined,
            ciphertextSize: target.ciphertext.byteLength,
            target: safeUrl(target.url),
          },
          response: safeResult,
        });
        if (result.status !== 200 || !result.responseHeaders["x-encrypted-param"]) {
          throw new Error(`raw CDN upload status=${result.status}`);
        }
        }
        await trace({
          at: new Date().toISOString(),
          event: "test_result",
          test: currentTest,
          status: "success",
          sourceSize: metadata.size,
          sourceSha256: sha256(plaintext),
          elapsedMs: elapsed(started),
          sendMessageExecuted,
        });
        matrixResults.push({
          fixture,
          variant,
          repetition,
          sourceSize: metadata.size,
          status: "success",
        });
      } catch (error) {
        await trace({
          at: new Date().toISOString(),
          event: "test_result",
          test: currentTest,
          status: "failed",
          sourceSize: metadata.size,
          sourceSha256: sha256(plaintext),
          elapsedMs: elapsed(started),
          sendMessageExecuted: false,
          error: safeError(error),
        });
        matrixResults.push({
          fixture,
          variant,
          repetition,
          sourceSize: metadata.size,
          status: "failed",
        });
      }
    }
  }
}

currentTest = undefined;
const fixedVariants = variants.filter((variant) => (
  variant.startsWith("fixed-")
  || variant === "legacy2110-post-full"
  || variant === "pinned-post-full"
  || variant === "freshconn-post-full"
  || variant === "expect-post-full"
  || variant === "curl-post-full"
  || variant === "derived-post-param"
  || variant === "derived-put-param"
));
const acceptanceFixtures = [...new Map(
  matrixResults
    .filter((result) => requiredAcceptanceRuns(result.sourceSize) !== undefined)
    .map((result) => [result.fixture, result.sourceSize] as const),
).entries()];
const hasControl = acceptanceFixtures.some(([, size]) => size <= 96 * 1024);
const hasReference = acceptanceFixtures.some(([, size]) => size >= 1_300_000 && size <= 2 * 1024 * 1024);
const hasLarge = acceptanceFixtures.some(([, size]) => size >= 15 * 1024 * 1024);
const qualifiedVariants = fixedVariants.filter((variant) => (
  hasControl
  && hasReference
  && hasLarge
  && acceptanceFixtures.every(([fixture, size]) => {
    const required = requiredAcceptanceRuns(size)!;
    const results = matrixResults.filter((result) => result.fixture === fixture && result.variant === variant);
    return results.length >= required && results.slice(0, required).every((result) => result.status === "success");
  })
)).sort((left, right) => {
  const methodPreference = Number(!left.includes("-put-")) - Number(!right.includes("-put-"));
  if (methodPreference !== 0) return methodPreference;
  return Number(left.endsWith("-param")) - Number(right.endsWith("-param"));
});
const selectedVariant = qualifiedVariants[0];
const supportFile = selectedVariant
  ? undefined
  : outputFile.replace(/\.jsonl$/i, "") + "-tencent-support.md";
if (supportFile) {
  const rows = supportAttempts.map((attempt) => (
    `| ${attempt.at} | ${attempt.fixture} | ${attempt.repetition} | ${attempt.method} | ${attempt.urlSource} | ${attempt.taskId ?? "-"} | ${attempt.status} | ${Math.round(attempt.elapsedMs)} | ${attempt.downloadParamPresent} |`
  ));
  await writeFile(supportFile, `# 腾讯 iLink CDN 原生附件协议矩阵

生成时间：${new Date().toISOString()}

全部候选组合均未满足连续成功门槛。测试只执行 CDN 上传，未调用 \`sendmessage\`。
材料不含 bot token、AES key、完整用户 ID 或完整上传签名参数。

| UTC 时间 | 文件 | 重复 | 方法 | URL 来源 | taskid | HTTP | 耗时 ms | x-encrypted-param |
|---|---|---:|---|---|---|---:|---:|---|
${rows.join("\n")}

请按 taskid 和 UTC 时间检查 iLink CDN 服务端日志，重点核对账号媒体权限、上传方法、
签名 URL 路由、密文长度、MD5 校验和边缘节点处理结果。
`, { encoding: "utf8", mode: 0o600 });
}
await trace({
  at: new Date().toISOString(),
  event: "matrix_acceptance",
  required: {
    control: { maxBytes: 96 * 1024, consecutiveRuns: 3, present: hasControl },
    reference: { minBytes: 1_300_000, maxBytes: 2 * 1024 * 1024, consecutiveRuns: 5, present: hasReference },
    large: { minBytes: 15 * 1024 * 1024, consecutiveRuns: 3, present: hasLarge },
  },
  qualifiedVariants,
  selectedVariant,
  verdict: selectedVariant ? "qualified" : "not-qualified",
});
await trace({
  at: new Date().toISOString(),
  event: "matrix_complete",
  outputTag: tag(outputFile),
});
process.stdout.write(`${JSON.stringify({
  ok: true,
  outputFile,
  fixtureCount: fixtures.length,
  variants,
  qualifiedVariants,
  selectedVariant,
  supportFile,
})}\n`);
