#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { callMediaBridge } from "../plugins/wechat-media-bridge/dist/client.js";
import { sendExactNativeFile } from "../plugins/wechat-media-bridge/dist/native-weixin.js";

const [filePath, caption = ""] = process.argv.slice(2);
if (!filePath || !path.isAbsolute(filePath)) {
  throw new Error("usage: send-native-attachment.mjs ABSOLUTE_FILE_PATH [CAPTION]");
}

const dataDir = "/opt/WeChat-Open in/data";
const accountId = process.env.WECHAT_MEDIA_ACCOUNT_ID?.trim();
if (!accountId) throw new Error("WECHAT_MEDIA_ACCOUNT_ID is not configured");
const credentialDir = process.env.CREDENTIALS_DIRECTORY;
if (!credentialDir) throw new Error("CREDENTIALS_DIRECTORY is not configured");
const expectedOwner = (await readFile(path.join(credentialDir, "owner-wechat-id"), "utf8")).trim();
if (!expectedOwner) throw new Error("owner credential is empty");

const inspected = await callMediaBridge("/v1/files/inspect", { path: filePath }, 30_000);
const requestedTransferId = process.env.WEIXIN_TRANSFER_ID?.trim();
if (requestedTransferId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedTransferId)) {
  throw new Error("WEIXIN_TRANSFER_ID must be a UUID");
}
const transferId = requestedTransferId ?? randomUUID();
const managedDelivery = process.env.WEIXIN_MANAGED_DELIVERY === "1";
const maxUploadAttemptsValue = process.env.WEIXIN_MAX_UPLOAD_ATTEMPTS?.trim();
const maxUploadAttempts = maxUploadAttemptsValue ? Number(maxUploadAttemptsValue) : undefined;
if (maxUploadAttempts !== undefined && (!Number.isSafeInteger(maxUploadAttempts) || maxUploadAttempts < 1 || maxUploadAttempts > 8)) {
  throw new Error("WEIXIN_MAX_UPLOAD_ATTEMPTS must be an integer between 1 and 8");
}
const queueAttemptValue = process.env.WEIXIN_QUEUE_ATTEMPT?.trim();
const queueAttempt = queueAttemptValue ? Number(queueAttemptValue) : undefined;
if (queueAttempt !== undefined && (!Number.isSafeInteger(queueAttempt) || queueAttempt < 1)) {
  throw new Error("WEIXIN_QUEUE_ATTEMPT must be a positive integer");
}
if (!managedDelivery) {
  await callMediaBridge("/v1/deliveries/register", {
    transferId,
    accountId,
    path: filePath,
  }, 30_000);
}

try {
  const sent = await sendExactNativeFile({
    accountId,
    dataDir,
    expectedOwner,
    expectedSha256: inspected.file.sha256,
    expectedSize: inspected.file.size,
    filePath,
    fileName: inspected.file.name,
    transferId,
    ...(caption ? { caption } : {}),
    ...(maxUploadAttempts === undefined ? {} : { maxUploadAttempts }),
    ...(queueAttempt === undefined ? {} : { queueAttempt }),
  });
  if (!managedDelivery) {
    await callMediaBridge("/v1/deliveries/complete", {
      transferId,
      success: true,
    }, 30_000);
  }
  console.log(JSON.stringify({
    ok: true,
    transferId,
    size: inspected.file.size,
    sha256: inspected.file.sha256,
    messageIdPresent: Boolean(sent.messageId),
  }));
} catch (error) {
  const errorCode = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "PLATFORM_SEND_FAILED";
  if (!managedDelivery) {
    await callMediaBridge("/v1/deliveries/complete", {
      transferId,
      success: false,
      errorCode,
    }, 30_000).catch(() => undefined);
  }
  console.error(JSON.stringify({ ok: false, transferId, errorCode }));
  throw error;
}
