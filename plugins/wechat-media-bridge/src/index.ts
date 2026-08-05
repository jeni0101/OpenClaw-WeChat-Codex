import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { definePluginEntry, type OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { callMediaBridge, MediaBridgeError } from "./client.js";
import { sendExactNativeFile } from "./native-weixin.js";

const WECHAT_CHANNEL = "openclaw-weixin";

interface PluginSettings {
  socketPath: string;
  accountId: string;
  workspaceRoot: string;
}

interface PendingDelivery { transferId: string; content: string }
interface FileInfo { name: string; mime: string; size: number; sha256: string; quarantined: boolean }
interface Registered { ok: true; transferId: string; state: string; file: FileInfo }
interface DeliveryStatus {
  ok: true;
  transferId: string;
  state: "pending" | "failed" | "succeeded";
  errorCode: string | null;
  file: FileInfo;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number | null;
  queued: boolean;
}
interface ActiveDelivery {
  ok: true;
  found: boolean;
  transferId?: string;
  state?: "pending";
  attempts?: number;
  nextAttemptAt?: number | null;
}
interface EnqueuedDelivery {
  ok: true;
  transferId: string;
  state: "pending" | "succeeded";
  duplicate: boolean;
  attempts?: number;
  nextAttemptAt?: number | null;
}

const pendingByRoute = new Map<string, PendingDelivery[]>();
const activeByFingerprint = new Map<string, { transferId: string; startedAt: number }>();
const ACTIVE_DEDUPE_MS = 10 * 60_000;
let ownerIdCache: string | undefined;

function settings(raw: Record<string, unknown> | undefined): PluginSettings {
  const accountId = typeof raw?.accountId === "string" ? raw.accountId.trim() : "";
  if (!accountId) throw new Error("wechat-media-bridge requires an explicit accountId");
  return {
    socketPath: typeof raw?.socketPath === "string" ? raw.socketPath : "/opt/WeChat-Open in/data/run/media-bridge.sock",
    accountId,
    workspaceRoot: typeof raw?.workspaceRoot === "string" ? raw.workspaceRoot : "/opt/WeChat-Open in/data/workspace",
  };
}

async function ownerId(): Promise<string> {
  if (ownerIdCache) return ownerIdCache;
  const credentialDir = process.env.CREDENTIALS_DIRECTORY;
  const file = process.env.WECHAT_OWNER_ID_FILE ?? (credentialDir ? path.join(credentialDir, "owner-wechat-id") : undefined);
  if (!file) throw new Error("owner credential is not configured for the media bridge");
  const value = (await readFile(file, "utf8")).trim();
  if (!value || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new Error("owner credential is invalid");
  ownerIdCache = value;
  return value;
}

function routeKey(accountId: string, to: string): string { return `${accountId}\u0000${to}`; }
function transferFingerprint(accountId: string, to: string, sha256: string): string {
  return `${routeKey(accountId, to)}\u0000${sha256}`;
}

function localMediaPath(value: string, workspaceRoot: string): string | undefined {
  if (value.startsWith("file://")) return decodeURIComponent(new URL(value).pathname);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return undefined;
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
}

function isManagedGeneratedImage(value: string, workspaceRoot: string): boolean {
  const generatedRoot = path.resolve(
    path.dirname(workspaceRoot),
    "state",
    "agents",
    "main",
    "agent",
    "codex-home",
    "generated_images",
  );
  const candidate = path.resolve(value);
  return candidate === generatedRoot || candidate.startsWith(`${generatedRoot}${path.sep}`);
}

function failureCategory(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (/^(?:SOURCE_HASH_CHANGED|WEIXIN_[A-Z0-9_]+)$/.test(code)) return code;
  }
  const value = String(error);
  if (/ret=-2|prepare failed/i.test(value)) return "WEIXIN_PREPARE_FAILED";
  if (/getUploadUrl|no upload URL/i.test(value)) return "WEIXIN_UPLOAD_URL";
  if (/-5104001/i.test(value)) return "WEIXIN_CDN_5104001";
  if (/(?:CDN|upload).{0,80}(?:HTTP )?500|(?:HTTP )?500.{0,80}(?:CDN|upload)/i.test(value)) return "WEIXIN_CDN_500";
  if (/CDN upload|upload_param/i.test(value)) return "WEIXIN_CDN";
  if (/remote media download|fetch/i.test(value)) return "REMOTE_MEDIA_FETCH";
  if (/timeout/i.test(value)) return "PLATFORM_TIMEOUT";
  return "PLATFORM_SEND_FAILED";
}

function toolResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function trustedRoute(context: OpenClawPluginToolContext, config: PluginSettings, expectedOwner: string) {
  const route = context.deliveryContext;
  // senderIsOwner is the framework's authoritative result from
  // commands.ownerAllowFrom. The Weixin adapter does not consistently expose
  // requesterSenderId to plugin tools, so the delivery route below is the
  // second identity check for the current private conversation.
  if (context.messageChannel !== WECHAT_CHANNEL || !context.senderIsOwner) {
    throw new Error("work-file tools are available only to the bound owner in a private WeChat conversation");
  }
  if (route?.channel !== WECHAT_CHANNEL || route.to !== expectedOwner || route.accountId !== config.accountId || route.threadId !== undefined) {
    throw new Error("work-file delivery route is not the bound owner private conversation");
  }
  return { to: expectedOwner, accountId: config.accountId };
}

export default definePluginEntry({
  id: "wechat-media-bridge",
  name: "WeChat Safe Media Bridge",
  description: "Owner-only exact-source native WeChat work-file transport",
  register(api) {
    const config = settings(api.pluginConfig);
    process.env.MEDIA_BRIDGE_SOCKET = config.socketPath;

    api.on("reply_payload_sending", async (event, context) => {
      const accountId = context.accountId ?? "";
      if (event.channel !== WECHAT_CHANNEL || context.channelId !== WECHAT_CHANNEL || accountId !== config.accountId) return;
      const expectedOwner = await ownerId();
      const to = context.conversationId ?? "";
      if (to !== expectedOwner) return { cancel: true, reason: "owner_private_chat_only" };
      const rawMedia = [
        ...(typeof event.payload.mediaUrl === "string" ? [event.payload.mediaUrl] : []),
        ...(Array.isArray(event.payload.mediaUrls) ? event.payload.mediaUrls : []),
      ].filter((value, index, values) => value.trim().length > 0 && values.indexOf(value) === index);
      if (rawMedia.length === 0) return;
      const paths = rawMedia.map((value) => localMediaPath(value, config.workspaceRoot));
      // Remote URLs remain the responsibility of the channel adapter. Local
      // ImageGen/workspace artifacts must pass through the exact-byte broker.
      if (paths.some((value) => value === undefined)) return;

      for (const resolvedPath of paths as string[]) {
        let inspected: { ok: true; file: FileInfo };
        try {
          inspected = await callMediaBridge<{ ok: true; file: FileInfo }>("/v1/files/inspect", {
            path: resolvedPath,
          }, 30_000);
        } catch (error) {
          const code = error instanceof MediaBridgeError ? error.code : "VALIDATION_FAILED";
          api.logger.warn(`generated media validation blocked errorCode=${code}`);
          return { cancel: true, reason: "media_policy_rejected" };
        }
        let deliveryPath = resolvedPath;
        let deliveryFile = inspected.file;
        if (
          inspected.file.mime.startsWith("image/")
          && inspected.file.size > 220 * 1024
          && isManagedGeneratedImage(resolvedPath, config.workspaceRoot)
        ) {
          const prepared = await callMediaBridge<{
            ok: true;
            path: string;
            file: FileInfo;
            converted: boolean;
          }>("/v1/files/prepare-weixin-image", { path: resolvedPath }, 120_000);
          deliveryPath = prepared.path;
          deliveryFile = prepared.file;
        }
        const fingerprint = transferFingerprint(accountId, to, deliveryFile.sha256);
        const active = activeByFingerprint.get(fingerprint);
        if (active && Date.now() - active.startedAt < ACTIVE_DEDUPE_MS) continue;
        if (active) activeByFingerprint.delete(fingerprint);

        const transferId = randomUUID();
        await callMediaBridge<Registered>("/v1/deliveries/register", {
          transferId,
          accountId,
          path: deliveryPath,
        }, 30_000);
        activeByFingerprint.set(fingerprint, { transferId, startedAt: Date.now() });
        void (async () => {
          try {
            await sendExactNativeFile({
              accountId,
              dataDir: path.dirname(config.workspaceRoot),
              expectedOwner,
              expectedSha256: deliveryFile.sha256,
              expectedSize: deliveryFile.size,
              filePath: deliveryPath,
              fileName: deliveryFile.name,
              transferId,
            });
            await callMediaBridge("/v1/deliveries/complete", { transferId, success: true }).catch(() => undefined);
          } catch (error) {
            const category = failureCategory(error);
            api.logger.warn(`generated native media send failed transferId=${transferId} errorCode=${category}`);
            await callMediaBridge("/v1/deliveries/complete", {
              transferId,
              success: false,
              errorCode: category,
            }).catch(() => undefined);
          } finally {
            const current = activeByFingerprint.get(fingerprint);
            if (current?.transferId === transferId) activeByFingerprint.delete(fingerprint);
          }
        })();
      }

      // The native upload above owns local generated media. Cancel the entire
      // original payload, including any text: a separate text response spends
      // the same Tencent sendmessage allowance required by the attachment.
      return { cancel: true, reason: "local_media_routed_to_exact_native_delivery" };
    }, { priority: 200, timeoutMs: 45_000 });

    api.on("message_sending", async (event, context) => {
      const accountId = context.accountId ?? (typeof event.metadata?.accountId === "string" ? event.metadata.accountId : "");
      const mediaUrls = Array.isArray(event.metadata?.mediaUrls) ? event.metadata.mediaUrls.filter((value): value is string => typeof value === "string") : [];
      if (accountId !== config.accountId || mediaUrls.length === 0) return;
      const expectedOwner = await ownerId();
      if (event.to !== expectedOwner) return { cancel: true, cancelReason: "owner_private_chat_only" };
      const mediaPath = localMediaPath(mediaUrls[0]!, config.workspaceRoot);
      if (!mediaPath) return;
      const key = routeKey(accountId, event.to);
      const transferId = randomUUID();
      try {
        await callMediaBridge<Registered>("/v1/deliveries/register", {
          transferId,
          accountId,
          path: mediaPath,
        }, 30_000);
      } catch (error) {
        if (error instanceof MediaBridgeError && error.code === "UNAVAILABLE") {
          api.logger.warn("media bridge unavailable; allowing native WeChat delivery without inspection");
          return;
        }
        const code = error instanceof MediaBridgeError ? error.code : "VALIDATION_FAILED";
        api.logger.warn(`media validation blocked transferId=${transferId} errorCode=${code}`);
        return { cancel: true, cancelReason: "media_policy_rejected", metadata: { errorCode: code } };
      }
      const queue = pendingByRoute.get(key) ?? [];
      queue.push({
        transferId,
        content: event.content,
      });
      pendingByRoute.set(key, queue);
      return;
    }, { priority: 100, timeoutMs: 45_000 });

    api.on("message_sent", async (event, context) => {
      const accountId = context.accountId ?? "";
      if (context.channelId !== WECHAT_CHANNEL || accountId !== config.accountId) return;
      const expectedOwner = await ownerId();
      if (event.to !== expectedOwner) return;
      const key = routeKey(accountId, event.to);
      const queue = pendingByRoute.get(key);
      const pending = queue?.[0];
      if (!pending || pending.content !== event.content) return;
      queue!.shift();
      if (queue!.length === 0) pendingByRoute.delete(key);
      await callMediaBridge("/v1/deliveries/complete", {
        transferId: pending.transferId,
        success: event.success,
        ...(event.success ? {} : { errorCode: failureCategory(event.error) }),
      }).catch((error) => api.logger.warn(`media completion record failed transferId=${pending.transferId} errorCode=${failureCategory(error)}`));
    }, { priority: 100, timeoutMs: 240_000 });

    api.on("gateway_stop", () => {
      pendingByRoute.clear();
      activeByFingerprint.clear();
      ownerIdCache = undefined;
    });

    api.registerTool((context) => ({
      name: "weixin_send_current_attachment",
      label: "Send a safe work file to the current owner",
      description: "Queue the exact validated source bytes for native delivery only to the current bound owner private WeChat conversation. This tool never compresses, rewrites, splits, renames or substitutes the source file. The immediate result is pending, never proof of delivery. After a successful queue result, emit exactly NO_REPLY: any acknowledgement or summary would consume the same Tencent sendmessage allowance needed by the attachment. Do not say sent/succeeded until status reports succeeded. No target parameter is accepted.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 8192 }),
        caption: Type.Optional(Type.String({ maxLength: 1000 })),
      }, { additionalProperties: false }),
      async execute(_id, raw) {
        const expectedOwner = await ownerId();
        const route = trustedRoute(context, config, expectedOwner);
        const params = raw as { path: string; caption?: string };
        const resolvedPath = path.isAbsolute(params.path) ? params.path : path.resolve(context.workspaceDir ?? config.workspaceRoot, params.path);
        const inspected = await callMediaBridge<{ ok: true; file: FileInfo }>("/v1/files/inspect", { path: resolvedPath }, 30_000);
        const persistedActive = await callMediaBridge<ActiveDelivery>("/v1/deliveries/active", {
          accountId: route.accountId,
          sha256: inspected.file.sha256,
        }, 30_000);
        if (persistedActive.found && persistedActive.transferId) {
          return toolResult(
            `同一文件已有持久上传任务（传输编号 ${persistedActive.transferId.slice(0, 8)}），请勿重复调用。任务会在媒体服务或 Gateway 重启后继续；当前尚未确认发送成功。`,
            {
              mode: "native_pending",
              transferId: persistedActive.transferId,
              duplicate: true,
              attempts: persistedActive.attempts,
              nextAttemptAt: persistedActive.nextAttemptAt,
              file: inspected.file,
            },
          );
        }
        const fingerprint = transferFingerprint(route.accountId, route.to, inspected.file.sha256);
        const active = activeByFingerprint.get(fingerprint);
        if (active && Date.now() - active.startedAt < ACTIVE_DEDUPE_MS) {
          return toolResult(
            `同一文件仍在后台上传（传输编号 ${active.transferId.slice(0, 8)}），请勿重复调用。当前尚未确认发送成功；必须等待微信确认消息。`,
            { mode: "native_pending", transferId: active.transferId, duplicate: true, file: inspected.file },
          );
        }
        if (active) activeByFingerprint.delete(fingerprint);

        const transferId = randomUUID();
        await callMediaBridge<Registered>("/v1/deliveries/register", {
          transferId,
          accountId: route.accountId,
          path: resolvedPath,
        }, 30_000);
        const enqueued = await callMediaBridge<EnqueuedDelivery>("/v1/deliveries/enqueue", {
          transferId,
          ...(params.caption ? { caption: params.caption } : {}),
        }, 30_000);
        return toolResult(
          `文件已进入微信原生附件持久上传队列（传输编号 ${enqueued.transferId.slice(0, 8)}）。当前状态仅为“上传中”，不代表已经发送成功。任务采用全局单并发和长冷却熔断，服务重启后会恢复；请勿重复调用。现在必须输出且只输出 NO_REPLY，避免队列提示或普通回复占用附件所需的腾讯 sendmessage 下行额度。`,
          {
            mode: "native_pending",
            transferId: enqueued.transferId,
            duplicate: enqueued.duplicate,
            attempts: enqueued.attempts,
            nextAttemptAt: enqueued.nextAttemptAt,
            file: inspected.file,
          },
        );
      },
      executionMode: "sequential",
    }), { name: "weixin_send_current_attachment" });

    api.registerTool((context) => ({
      name: "weixin_get_attachment_status",
      label: "Get native WeChat attachment status",
      description: "Read the authoritative state of a native WeChat attachment transfer by its UUID or displayed 8-character prefix. Use this whenever the owner asks whether an upload succeeded, failed, is stuck, or hit a size limit. Never infer status from elapsed time.",
      parameters: Type.Object({
        transferId: Type.String({ minLength: 8, maxLength: 36 }),
      }, { additionalProperties: false }),
      async execute(_id, raw) {
        const expectedOwner = await ownerId();
        trustedRoute(context, config, expectedOwner);
        const params = raw as { transferId: string };
        const status = await callMediaBridge<DeliveryStatus>("/v1/deliveries/status", {
          transferId: params.transferId,
        }, 30_000);
        const shortId = status.transferId.slice(0, 8);
        const text = status.state === "succeeded"
          ? `传输 ${shortId} 已由微信确认原生附件发送成功。`
          : status.state === "failed"
            ? `传输 ${shortId} 已失败，错误码：${status.errorCode ?? "PLATFORM_SEND_FAILED"}。这不是“仍在上传”。`
            : `传输 ${shortId} 仍在持久队列中，已尝试 ${status.attempts} 次${status.nextAttemptAt ? `，下次计划时间 ${new Date(status.nextAttemptAt).toISOString()}` : ""}。尚未收到微信成功确认。`;
        return toolResult(text, {
          mode: "native_status",
          transferId: status.transferId,
          state: status.state,
          errorCode: status.errorCode,
          file: status.file,
          createdAt: status.createdAt,
          updatedAt: status.updatedAt,
          attempts: status.attempts,
          nextAttemptAt: status.nextAttemptAt,
          queued: status.queued,
        });
      },
    }), { name: "weixin_get_attachment_status" });

    api.registerTool((context) => ({
      name: "workfile_import_generated_image",
      label: "Import a generated image into the workspace",
      description: "Safely import an ImageGen output from the exact managed generated-images directory into workspace media/outbound/imported-generated. Use this instead of Bash/cp whenever a generated image is needed by a document or build. It cannot read arbitrary paths and never overwrites an existing file.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 8192 }),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })),
      }, { additionalProperties: false }),
      async execute(_id, raw) {
        const expectedOwner = await ownerId();
        trustedRoute(context, config, expectedOwner);
        const params = raw as { path: string; name?: string };
        const imported = await callMediaBridge<{
          ok: true;
          path: string;
          file: FileInfo;
          reused: boolean;
        }>("/v1/files/import-generated", {
          path: params.path,
          ...(params.name ? { name: params.name } : {}),
        }, 30_000);
        return toolResult(
          `生成图片已通过安全校验并导入工作区：${imported.path}`,
          { mode: "workspace_import", path: imported.path, file: imported.file, reused: imported.reused },
        );
      },
    }), { name: "workfile_import_generated_image" });

    api.registerTool((context) => ({
      name: "workfile_extract",
      label: "Extract safe work-file content",
      description: "Read text from TXT/CSV/JSON/YAML/XML, DOCX, XLSX or PPTX inside managed media roots. PDF files must use the pdf tool.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 8192 }),
        sheet: Type.Optional(Type.String({ maxLength: 128 })),
        cellRange: Type.Optional(Type.String({ maxLength: 32 })),
        slides: Type.Optional(Type.String({ maxLength: 128 })),
        maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 200000 })),
      }, { additionalProperties: false }),
      async execute(_id, raw) {
        const expectedOwner = await ownerId();
        trustedRoute(context, config, expectedOwner);
        const params = raw as { path: string; sheet?: string; cellRange?: string; slides?: string; maxChars?: number };
        const resolvedPath = path.isAbsolute(params.path) ? params.path : path.resolve(context.workspaceDir ?? config.workspaceRoot, params.path);
        const extracted = await callMediaBridge<{ ok: true; text: string; file: FileInfo }>("/v1/files/extract", {
          path: resolvedPath,
          ...(params.sheet ? { sheet: params.sheet } : {}),
          ...(params.cellRange ? { cellRange: params.cellRange } : {}),
          ...(params.slides ? { slides: params.slides } : {}),
          ...(params.maxChars ? { maxChars: params.maxChars } : {}),
        }, 60_000);
        return toolResult(extracted.text, { file: extracted.file });
      },
    }), { name: "workfile_extract" });
  },
});
