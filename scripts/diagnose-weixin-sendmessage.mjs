#!/usr/bin/env node

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { sendMessageItemWeixin } from "@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js";

const dataDir = "/opt/WeChat-Open in/data";
const accountId = process.env.WECHAT_MEDIA_ACCOUNT_ID?.trim();
if (!accountId) throw new Error("WECHAT_MEDIA_ACCOUNT_ID is not configured");
const withoutContext = process.argv.includes("--without-context");
const credentialDir = process.env.CREDENTIALS_DIRECTORY;
if (!credentialDir) throw new Error("CREDENTIALS_DIRECTORY is not configured");

const owner = (await readFile(path.join(credentialDir, "owner-wechat-id"), "utf8")).trim();
const account = JSON.parse(await readFile(
  path.join(dataDir, "state", "openclaw-weixin", "accounts", `${accountId}.json`),
  "utf8",
));
const contexts = JSON.parse(await readFile(
  path.join(dataDir, "state", "openclaw-weixin", "accounts", `${accountId}.context-tokens.json`),
  "utf8",
));
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

try {
  await sendMessageItemWeixin({
    to: owner,
    clientId: `openclaw-weixin-diagnostic-${crypto.randomUUID()}`,
    label: "diagnoseWeixinSendMessage",
    item: {
      type: 1,
      text_item: {
        text: withoutContext
          ? "灰度诊断：微信无 context 纯文本通道正常，附件队列仍在冷却。"
          : "灰度诊断：微信纯文本消息通道正常，附件队列仍在冷却。",
      },
    },
    opts: {
      baseUrl: account.baseUrl,
      token: account.token,
      timeoutMs: 20_000,
      ...(withoutContext ? {} : { contextToken: entries[0][1] }),
    },
  });
  console.log(JSON.stringify({
    ok: true,
    kind: withoutContext ? "text_control_without_context_accepted" : "text_control_accepted",
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const ret = Number(message.match(/\bret=(-?\d+)/)?.[1]);
  const errmsg = message.match(/\berrmsg=(.*)$/)?.[1]?.trim() ?? "";
  const normalized = errmsg.toLowerCase();
  const errmsgKind = /rate|频率|too many|limit/.test(normalized)
    ? "rate_limit"
    : /context|token|session|会话|登录/.test(normalized)
      ? "context_or_session"
      : /param|invalid|参数/.test(normalized)
        ? "parameter"
        : errmsg
          ? "other"
          : "none";
  console.log(JSON.stringify({
    ok: false,
    withoutContext,
    ret: Number.isFinite(ret) ? ret : undefined,
    errmsgKind,
    errmsgTag: errmsg
      ? crypto.createHash("sha256").update(errmsg).digest("hex").slice(0, 12)
      : undefined,
  }));
  process.exitCode = 2;
}
