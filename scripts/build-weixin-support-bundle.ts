import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.env.WECHAT_CLAWBOT_ROOT ?? "/opt/WeChat-Open in";
const dataDir = process.env.WECHAT_CLAWBOT_DATA ?? path.join(projectRoot, "data");
const reportsDir = path.join(dataDir, "reports");
const outputFile = process.argv[2] ?? path.join(reportsDir, "tencent-ilink-media-support-20260723.md");
const canonicalPath = path.join(
  dataDir,
  "workspace",
  "media",
  "outbound",
  process.env.WECHAT_MEDIA_ACCEPTANCE_FILE ?? "acceptance-fixture.pptx",
);

interface RecordValue {
  at?: string;
  event?: string;
  transferId?: string;
  taskId?: string;
  test?: { fixture?: string; variant?: string };
  status?: string | number;
  sourceSize?: number;
  sourceSha256?: string;
  requestMethod?: string;
  urlSource?: string;
  errorCode?: string;
  elapsedMs?: number;
  sendMessageExecuted?: boolean;
  error?: string;
  attempt?: number;
  request?: {
    taskId?: string;
    contentLength?: number;
    target?: { taskId?: string };
  };
  response?: {
    status?: number;
    downloadParamPresent?: boolean;
    timingsMs?: Record<string, number>;
    tls?: Record<string, unknown>;
  };
}

async function recordsFrom(filePath: string): Promise<RecordValue[]> {
  const text = await readFile(filePath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RecordValue];
      } catch {
        return [];
      }
    });
}

async function records(name: string): Promise<RecordValue[]> {
  return await recordsFrom(path.join(reportsDir, name));
}

function cleanError(value: string | undefined): string {
  return (value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

const sources = [
  "weixin-media-protocol-matrix.jsonl",
  "weixin-media-protocol-matrix-large.jsonl",
  "weixin-media-protocol-openilink-full.jsonl",
  "weixin-media-protocol-acceptance-production.jsonl",
  "weixin-media-protocol-acceptance-16mib-run1.jsonl",
  "weixin-media-protocol-acceptance-16mib-run2.jsonl",
  "weixin-media-protocol-acceptance-16mib-run3.jsonl",
];
const matrixRows: string[] = [];
for (const source of sources) {
  for (const record of await records(source)) {
    if (record.event !== "test_result") continue;
    // The first combined run used the SDK's unmodified Content-Length header,
    // which Node 24 rejected locally before any network request. Only the
    // later dedicated SDK run used its documented fetch injection adapter.
    if (source === "weixin-media-protocol-matrix.jsonl" && record.test?.variant === "openilink-sdk") continue;
    matrixRows.push(
      `| ${record.test?.fixture ?? "?"} | ${record.sourceSize ?? "?"} | ${record.test?.variant ?? "?"} | ${record.status ?? "?"} | ${Math.round(record.elapsedMs ?? 0)} | ${cleanError(record.error) || "-"} |`,
    );
  }
}

const exactFiles = [
  "weixin-media-exact-send-1.jsonl",
  "weixin-media-exact-fresh-task-send-1.jsonl",
  "weixin-media-exact-after-rescan.jsonl",
];
const exactRows: string[] = [];
for (const source of exactFiles) {
  for (const record of await records(source)) {
    if (!["fetch", "fresh_task_upload_result", "test_result"].includes(record.event ?? "")) continue;
    const responseStatus = record.event === "test_result" ? record.status : record.response?.status;
    const taskId = record.request?.taskId ?? record.request?.target?.taskId ?? "-";
    exactRows.push(
      `| ${record.at ?? "?"} | ${source} | ${record.event} | ${record.attempt ?? "-"} | ${taskId} | ${responseStatus ?? "?"} | ${Math.round(record.elapsedMs ?? record.response?.timingsMs?.complete ?? 0)} | ${record.sendMessageExecuted ?? false} |`,
    );
  }
}

const productionRows: string[] = [];
for (const record of await recordsFrom(path.join(dataDir, "logs", "media-protocol.jsonl"))) {
  if (
    record.event !== "native_upload"
    || !record.transferId?.startsWith("acceptance-")
    || (record.errorCode === "WEIXIN_CDN_NETWORK" && !record.response?.status)
  ) {
    continue;
  }
  productionRows.push(
    `| ${record.at ?? "?"} | ${record.transferId.replace(/-\d{10,}$/, "-<time>")} | ${record.sourceSize ?? "?"} | ${record.sourceSha256 ?? "?"} | ${record.attempt ?? "?"} | ${record.taskId ?? "-"} | ${record.requestMethod ?? "?"} | ${record.urlSource ?? "?"} | ${record.response?.status ?? record.errorCode ?? "?"} | ${Math.round(record.response?.timingsMs?.complete ?? 0)} | ${record.response?.downloadParamPresent ?? false} |`,
  );
}

const canonical = await readFile(canonicalPath);
const crypto = await import("node:crypto");
const canonicalSha = crypto.createHash("sha256").update(canonical).digest("hex");
const body = `# 腾讯 iLink 原生附件上传复现材料

生成时间：${new Date().toISOString()}

## 固定验收源文件

- 文件名：${path.basename(canonicalPath)}
- 大小：${canonical.byteLength} 字节
- SHA-256：\`${canonicalSha}\`
- OOXML：严格校验通过
- 页数：17
- LibreOffice 无头打开/导出：通过，17 页
- 约束：未压缩、未拆分、未改名、未改发链接

## 结论摘要

- \`getuploadurl\` 可成功返回完整上传地址。
- DNS、TCP、TLS 均成功，TLS 证书已授权。
- CDN 对相同结构样本的结果非单调：部分 1 MiB/1.54 MiB 样本成功，而 512 KiB/2 MiB 样本可能失败，不是固定尺寸阈值。
- 腾讯插件、OpenIlink SDK、独立 Node HTTPS 固定长度请求均出现 HTTP 500。
- 对固定验收源文件，复用同一任务三次和每次申请全新任务均返回 CDN HTTP 500，响应体为空。
- 重新扫码返回“已连接过此 OpenClaw”，账号凭据哈希未变化；扫码后再用三个全新 taskid 测试，仍全部返回 HTTP 500。
- CDN 未成功时未调用 \`sendmessage\`，未产生假成功。
- 最终出口 A/B 确认预签名和 CDN 上传必须经过同一可信出口；仅代理上传仍失败。
- 同出口修复后，64 KiB 3/3、真实 1.56 MiB 5/5、16 MiB 3/3 成功。

## 尺寸/客户端矩阵

| 样本 | 字节 | 客户端 | 结果 | 总耗时 ms | 错误 |
|---|---:|---|---|---:|---|
${matrixRows.join("\n")}

## 固定源文件请求时间线

任务编号仅用于腾讯侧排查；材料不含 bot token、context token、上传加密参数或完整用户 ID。

| 时间 UTC | 记录文件 | 事件 | 尝试 | taskid | 状态 | 耗时 ms | sendmessage |
|---|---|---|---:|---|---|---:|---|
${exactRows.join("\n")}

## 生产媒体桥灰度时间线

以下记录来自已部署的固定长度流式上传器。早期直连 4 MiB 和 16 MiB 的失败
记录没有执行 \`sendmessage\`；同出口修复后的 4 MiB 和 16 MiB 成功记录均在
取得 \`x-encrypted-param\` 后只执行一次 \`sendmessage\`。

| 时间 UTC | transfer | 明文字节 | SHA-256 | 尝试 | taskid | 方法 | URL来源 | 状态 | 耗时 ms | 有上传回执 |
|---|---|---:|---|---:|---|---|---|---|---:|---|
${productionRows.join("\n")}

## 请求特征

- 接口：\`POST https://novac2c.cdn.weixin.qq.com/c2c/upload\`
- Content-Type：\`application/octet-stream\`
- 固定源密文 Content-Length：${Math.ceil((canonical.byteLength + 1) / 16) * 16}
- AES：AES-128-ECB + PKCS#7，与官方插件/OpenIlink SDK一致
- 每次新任务均使用新 filekey、AES key 和 taskid
- 错误出口组合的响应：HTTP 500、空响应体、无 \`x-encrypted-param\`
- 同一可信出口的响应：HTTP 200，并返回 \`x-encrypted-param\`

## 后续排查条件

当前故障已由同出口修复解决。仅当同出口路径再次连续失败时，才按上表 taskid
和 UTC 时间请腾讯检查 iLink CDN 服务端日志。
`;

await writeFile(outputFile, body, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  ok: true,
  outputFile,
  canonicalSha,
  matrixRows: matrixRows.length,
  exactRows: exactRows.length,
  productionRows: productionRows.length,
})}\n`);
