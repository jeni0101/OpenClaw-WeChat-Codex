#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";

import { callMediaBridge } from "../plugins/wechat-media-bridge/dist/client.js";

const [filePath, caption = ""] = process.argv.slice(2);
if (!filePath || !path.isAbsolute(filePath)) {
  throw new Error("usage: enqueue-native-attachment.mjs ABSOLUTE_FILE_PATH [CAPTION]");
}
if (caption.length > 1000) throw new Error("caption must not exceed 1000 characters");

const accountId = process.env.WECHAT_MEDIA_ACCOUNT_ID?.trim();
if (!accountId) throw new Error("WECHAT_MEDIA_ACCOUNT_ID is not configured");
const inspected = await callMediaBridge("/v1/files/inspect", { path: filePath }, 30_000);
const active = await callMediaBridge("/v1/deliveries/active", {
  accountId,
  sha256: inspected.file.sha256,
}, 30_000);
if (active.found) {
  console.log(JSON.stringify({
    ok: true,
    duplicate: true,
    transferId: active.transferId,
    attempts: active.attempts,
    nextAttemptAt: active.nextAttemptAt,
    file: inspected.file,
  }));
  process.exit(0);
}

const transferId = randomUUID();
await callMediaBridge("/v1/deliveries/register", {
  transferId,
  accountId,
  path: filePath,
}, 30_000);
const enqueued = await callMediaBridge("/v1/deliveries/enqueue", {
  transferId,
  ...(caption ? { caption } : {}),
}, 30_000);
console.log(JSON.stringify({
  ok: true,
  duplicate: enqueued.duplicate,
  transferId: enqueued.transferId,
  state: enqueued.state,
  attempts: enqueued.attempts,
  nextAttemptAt: enqueued.nextAttemptAt,
  file: inspected.file,
}));
