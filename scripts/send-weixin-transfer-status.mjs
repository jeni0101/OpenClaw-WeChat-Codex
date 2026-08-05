#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { sendMessageWeixin } from "@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js";

const [text] = process.argv.slice(2);
if (!text || text.length > 2000 || /[\u0000]/.test(text)) {
  throw new Error("usage: send-weixin-transfer-status.mjs TEXT");
}

const dataDir = "/opt/WeChat-Open in/data";
const accountId = process.env.WECHAT_MEDIA_ACCOUNT_ID?.trim();
if (!accountId) throw new Error("WECHAT_MEDIA_ACCOUNT_ID is not configured");
const credentialDir = process.env.CREDENTIALS_DIRECTORY;
if (!credentialDir) throw new Error("CREDENTIALS_DIRECTORY is not configured");
const expectedOwner = (await readFile(path.join(credentialDir, "owner-wechat-id"), "utf8")).trim();
const account = JSON.parse(await readFile(
  path.join(dataDir, "state", "openclaw-weixin", "accounts", `${accountId}.json`),
  "utf8",
));
const contexts = JSON.parse(await readFile(
  path.join(dataDir, "state", "openclaw-weixin", "accounts", `${accountId}.context-tokens.json`),
  "utf8",
));
const ownerEntries = Object.entries(contexts).filter(([owner, token]) => owner && token);
if (
  !expectedOwner
  || !account.token
  || !account.baseUrl
  || ownerEntries.length !== 1
  || ownerEntries[0][0] !== expectedOwner
) {
  throw new Error("Weixin owner context does not match the configured account");
}

const sent = await sendMessageWeixin({
  to: expectedOwner,
  text,
  opts: {
    baseUrl: account.baseUrl,
    token: account.token,
    timeoutMs: 20_000,
    contextToken: ownerEntries[0][1],
  },
});
console.log(JSON.stringify({ ok: true, messageIdPresent: Boolean(sent.messageId) }));
