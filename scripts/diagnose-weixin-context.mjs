#!/usr/bin/env node

import crypto from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { getConfig } from "@tencent-weixin/openclaw-weixin/dist/src/api/api.js";

const dataDir = "/opt/WeChat-Open in/data";
const accountId = process.env.WECHAT_MEDIA_ACCOUNT_ID?.trim();
if (!accountId) throw new Error("WECHAT_MEDIA_ACCOUNT_ID is not configured");
const credentialDir = process.env.CREDENTIALS_DIRECTORY;
if (!credentialDir) throw new Error("CREDENTIALS_DIRECTORY is not configured");

const owner = (await readFile(path.join(credentialDir, "owner-wechat-id"), "utf8")).trim();
const accountFile = path.join(
  dataDir,
  "state",
  "openclaw-weixin",
  "accounts",
  `${accountId}.json`,
);
const contextFile = path.join(
  dataDir,
  "state",
  "openclaw-weixin",
  "accounts",
  `${accountId}.context-tokens.json`,
);
const account = JSON.parse(await readFile(accountFile, "utf8"));
const contexts = JSON.parse(await readFile(contextFile, "utf8"));
const entries = Object.entries(contexts).filter(([key, value]) => key && value);
if (
  !owner
  || !account.token
  || !account.baseUrl
  || entries.length !== 1
  || entries[0][0] !== owner
) {
  throw new Error("Weixin owner context does not match the configured account");
}

const response = await getConfig({
  baseUrl: account.baseUrl,
  token: account.token,
  timeoutMs: 20_000,
  ilinkUserId: owner,
  contextToken: entries[0][1],
});
const errmsg = typeof response.errmsg === "string" ? response.errmsg : "";
const normalized = errmsg.toLowerCase();
const errmsgKind = /rate|频率|too many/.test(normalized)
  ? "rate_limit"
  : /context|token|session|会话|登录/.test(normalized)
    ? "context_or_session"
    : /param|invalid|参数/.test(normalized)
      ? "parameter"
      : errmsg
        ? "other"
        : "none";
const contextInfo = await stat(contextFile);
console.log(JSON.stringify({
  ok: response.ret === undefined || response.ret === 0,
  ret: response.ret,
  errcode: response.errcode,
  errmsgKind,
  errmsgTag: errmsg
    ? crypto.createHash("sha256").update(errmsg).digest("hex").slice(0, 12)
    : undefined,
  typingTicketPresent: Boolean(response.typing_ticket),
  contextFileMtime: contextInfo.mtime.toISOString(),
}));
