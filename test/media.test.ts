import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyNativeSendFailure,
  configuredUploadMethod,
  configuredUploadMethods,
  executeNativeAttachmentFirst,
  executeNativeSendRetry,
  nativeMessageClientId,
  nativeMediaKind,
  readOwnerContextToken,
  retryDelaysForSize,
  waitForContextTokenChange,
} from "../plugins/wechat-media-bridge/src/native-weixin.js";
import { extractWorkFile, importGeneratedImage, inspectWorkFile, MAX_WORK_FILE_BYTES } from "../src/media/files.js";
import {
  NATIVE_BOUNDARY_THRESHOLD_BYTES,
  NATIVE_FAILURE_COOLDOWN_MS,
  NATIVE_SUCCESS_COOLDOWN_MS,
  nativeQueueCircuitBlocks,
  nativeQueueContextRefreshSatisfied,
  nativeQueueFailureCircuitUntil,
  nativeQueueInitialAttemptAt,
  nativeQueueMessageRefreshBlocks,
  nativeQueueNextDelay,
  nativeQueueOpensCircuit,
  nativeQueueOpensMessageCircuit,
  nativeQueueRetryDelays,
} from "../src/media/native-queue.js";
import { validatedWeixinCdnChildEnvironment } from "../src/weixin-cdn-env.js";

const roots: string[] = [];

function storedZip(entries: Array<{ name: string; data: string | Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name);
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wechat-media-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("native WeChat media routing", () => {
  it("reserves Tencent sendmessage allowance for the attachment", async () => {
    const pluginSource = await readFile(
      new URL("../plugins/wechat-media-bridge/src/index.ts", import.meta.url),
      "utf8",
    );
    const bridgeSource = await readFile(
      new URL("../scripts/media-bridge.ts", import.meta.url),
      "utf8",
    );
    expect(pluginSource).not.toContain("outbound.sendText");
    expect(pluginSource).not.toContain("文件已进入持久上传队列。大文件失败会自动");
    expect(pluginSource).not.toContain("微信已确认原生附件发送成功。");
    expect(pluginSource).not.toContain("textOnlyPayload");
    expect(pluginSource).toContain("emit exactly NO_REPLY");
    expect(bridgeSource).toContain("media.message_circuit_released_by_inbound");
  });

  it("detects a fresh inbound context during sendmessage backoff", async () => {
    const root = await fixture();
    const contextFile = path.join(root, "context-tokens.json");
    const owner = "owner@im.wechat";
    await writeFile(contextFile, JSON.stringify({ [owner]: "context-before" }));
    expect(await readOwnerContextToken(contextFile, owner)).toBe("context-before");
    const update = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void writeFile(contextFile, JSON.stringify({ [owner]: "context-after" }))
          .then(() => resolve(), reject);
      }, 10);
    });
    await expect(waitForContextTokenChange({
      contextFile,
      expectedOwner: owner,
      previousToken: "context-before",
      milliseconds: 100,
    })).resolves.toBe(true);
    await update;
    expect(await readOwnerContextToken(contextFile, owner)).toBe("context-after");
  });

  it("uses the official image, video and file protocol categories", () => {
    expect(nativeMediaKind("diagram.PNG")).toBe("image");
    expect(nativeMediaKind("clip.mp4")).toBe("video");
    expect(nativeMediaKind("report.pptx")).toBe("file");
  });

  it("uses only acceptance-qualified CDN methods in production", () => {
    expect(configuredUploadMethod(undefined)).toBe("POST");
    expect(configuredUploadMethods("POST", undefined)).toEqual(["POST", "POST", "POST", "POST"]);
    expect(configuredUploadMethods("POST", "PUT")).toEqual(["POST", "PUT", "POST", "PUT"]);
    expect(configuredUploadMethods("PUT", "PUT")).toEqual(["PUT", "PUT", "PUT", "PUT"]);
    expect(configuredUploadMethods("POST", undefined, 6)).toEqual([
      "POST", "POST", "POST", "POST", "POST", "POST",
    ]);
    expect(() => configuredUploadMethods("POST", undefined, 9)).toThrow("attempt count");
  });

  it("derives stable Tencent client ids from the persistent transfer id", () => {
    const transferId = "5d390cd2-1c54-429b-b1bf-64e05bfc14c6";
    expect(nativeMessageClientId(transferId, "media")).toBe(
      "openclaw-weixin-5d390cd2-1c54-429b-b1bf-64e05bfc14c6-media",
    );
    expect(nativeMessageClientId(transferId, "caption")).toBe(
      "openclaw-weixin-5d390cd2-1c54-429b-b1bf-64e05bfc14c6-caption",
    );
    expect(() => nativeMessageClientId("not-a-uuid", "media")).toThrow("invalid native transfer id");
  });

  it("retries transient sendmessage failures without changing the upload receipt", async () => {
    const delays: number[] = [];
    const failures: string[] = [];
    let calls = 0;
    const result = await executeNativeSendRetry({
      async send() {
        calls += 1;
        if (calls === 1) throw new Error("sendMessage 500: temporary");
        if (calls === 2) throw new TypeError("fetch failed");
        return "same-upload-receipt";
      },
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
      onFailure(event) {
        failures.push(event.failure.kind);
      },
    });
    expect(result).toEqual({ value: "same-upload-receipt", attempts: 3 });
    expect(delays).toEqual([5_000, 15_000]);
    expect(failures).toEqual(["http_5xx", "network"]);
  });

  it("does not retry a permanent sendmessage 4xx response", async () => {
    expect(classifyNativeSendFailure(new Error("sendMessage 429: busy"))).toMatchObject({
      kind: "http_4xx",
      retryable: true,
      status: 429,
    });
    expect(classifyNativeSendFailure(new Error("sendMessage 413: too large"))).toMatchObject({
      kind: "http_4xx",
      retryable: false,
      status: 413,
    });
    const delays: number[] = [];
    await expect(executeNativeSendRetry({
      send: async () => {
        throw new Error("sendMessage 413: too large");
      },
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    })).rejects.toThrow("413");
    expect(delays).toEqual([]);
  });

  it("uses long same-receipt backoff for Tencent sendmessage ret=-2", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await executeNativeSendRetry({
      async send() {
        calls += 1;
        if (calls < 3) throw new Error("sendMessage ret=-2 errmsg=rate limited");
        return "accepted";
      },
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    expect(result).toEqual({ value: "accepted", attempts: 3 });
    expect(delays).toEqual([60_000, 5 * 60_000]);
  });

  it("sends the attachment first and does not let an optional caption block success", async () => {
    const order: string[] = [];
    const captionFailures: string[] = [];
    const result = await executeNativeAttachmentFirst({
      sendMedia: async () => {
        order.push("media");
        return "attachment-message-id";
      },
      sendCaption: async () => {
        order.push("caption");
        throw new Error("sendMessage ret=-14 errmsg=busy");
      },
      onCaptionFailure(failure) {
        captionFailures.push(`${failure.kind}:${failure.apiRet}`);
      },
    });
    expect(order).toEqual(["media", "caption"]);
    expect(result).toEqual({
      value: "attachment-message-id",
      mediaAttempts: 1,
      captionAttempted: true,
      captionSucceeded: false,
    });
    expect(captionFailures).toEqual(["api_ret:-14"]);
  });

  it("spaces fresh Tencent tasks according to attachment size", () => {
    expect(retryDelaysForSize(64 * 1024)).toEqual([5_000, 15_000, 45_000]);
    expect(retryDelaysForSize(914_824)).toEqual([60_000, 120_000, 240_000]);
    expect(retryDelaysForSize(16 * 1024 * 1024)).toEqual([
      60_000, 120_000, 180_000, 240_000, 300_000,
    ]);
    expect(() => retryDelaysForSize(-1)).toThrow("invalid upload size");
  });

  it("keeps long delivery backoff from becoming a long account-wide circuit", () => {
    expect(nativeQueueRetryDelays(512 * 1024 - 1)).toEqual([
      60_000,
      5 * 60_000,
      15 * 60_000,
      30 * 60_000,
    ]);
    expect(nativeQueueRetryDelays(512 * 1024)).toEqual([
      15 * 60_000,
      30 * 60_000,
      60 * 60_000,
      120 * 60_000,
      240 * 60_000,
      480 * 60_000,
    ]);
    expect(nativeQueueRetryDelays(48 * 1024 * 1024)).toEqual([
      15 * 60_000,
      30 * 60_000,
      60 * 60_000,
      60 * 60_000,
      60 * 60_000,
      60 * 60_000,
    ]);
    expect(NATIVE_FAILURE_COOLDOWN_MS).toBe(15 * 60_000);
    expect(NATIVE_SUCCESS_COOLDOWN_MS).toBe(15 * 60_000);
    expect(nativeQueueNextDelay(48 * 1024 * 1024, 1, "WEIXIN_CDN_5XX")).toBe(15 * 60_000);
    expect(nativeQueueNextDelay(48 * 1024 * 1024, 6, "WEIXIN_CDN_5XX")).toBe(60 * 60_000);
    expect(nativeQueueNextDelay(48 * 1024 * 1024, 7, "WEIXIN_CDN_5XX")).toBeUndefined();
    expect(nativeQueueNextDelay(48 * 1024 * 1024, 1, "WEIXIN_SEND_FAILED")).toBe(15 * 60_000);
    expect(nativeQueueNextDelay(48 * 1024 * 1024, 6, "WEIXIN_SEND_FAILED")).toBe(15 * 60_000);
    expect(nativeQueueNextDelay(48 * 1024 * 1024, 7, "WEIXIN_SEND_FAILED")).toBeUndefined();
    expect(nativeQueueNextDelay(48 * 1024 * 1024, 1, "WEIXIN_CDN_4XX")).toBeUndefined();
    expect(nativeQueueOpensCircuit("WEIXIN_CDN_5XX")).toBe(true);
    expect(nativeQueueOpensCircuit("WEIXIN_SEND_FAILED")).toBe(false);
    expect(nativeQueueOpensMessageCircuit("WEIXIN_SEND_FAILED")).toBe(true);
    expect(nativeQueueOpensMessageCircuit("WEIXIN_CDN_5XX")).toBe(false);
    expect(nativeQueueMessageRefreshBlocks(0)).toBe(false);
    expect(nativeQueueMessageRefreshBlocks(1_000)).toBe(true);
    expect(nativeQueueContextRefreshSatisfied(1_000, 1_000)).toBe(false);
    expect(nativeQueueContextRefreshSatisfied(1_000, 1_001)).toBe(true);
    expect(() => nativeQueueContextRefreshSatisfied(-1, 1_001)).toThrow("refresh requirement");
    const now = 1_000_000;
    expect(nativeQueueFailureCircuitUntil(now)).toBe(now + 15 * 60_000);
    expect(nativeQueueFailureCircuitUntil(now)).toBeLessThan(
      now + nativeQueueNextDelay(32 * 1024 * 1024, 6, "WEIXIN_CDN_5XX")!,
    );
    expect(() => nativeQueueFailureCircuitUntil(-1)).toThrow("completion time");
    const circuitUntil = now + 15 * 60_000;
    const boundaryCircuitUntil = now + 8 * 60 * 60_000;
    expect(NATIVE_BOUNDARY_THRESHOLD_BYTES).toBe(40 * 1024 * 1024);
    expect(nativeQueueInitialAttemptAt(48 * 1024 * 1024, now, circuitUntil)).toBe(circuitUntil);
    expect(nativeQueueCircuitBlocks(48 * 1024 * 1024, now, circuitUntil)).toBe(true);
    expect(nativeQueueInitialAttemptAt(
      48 * 1024 * 1024,
      now,
      0,
      boundaryCircuitUntil,
    )).toBe(boundaryCircuitUntil);
    expect(nativeQueueCircuitBlocks(
      48 * 1024 * 1024,
      now,
      0,
      boundaryCircuitUntil,
    )).toBe(true);
    expect(nativeQueueInitialAttemptAt(
      32 * 1024 * 1024,
      now,
      0,
      boundaryCircuitUntil,
    )).toBe(now);
    expect(nativeQueueCircuitBlocks(
      32 * 1024 * 1024,
      now,
      0,
      boundaryCircuitUntil,
    )).toBe(false);
    expect(nativeQueueCircuitBlocks(512 * 1024, now, circuitUntil)).toBe(true);
    expect(nativeQueueInitialAttemptAt(64 * 1024, now, circuitUntil)).toBe(now);
    expect(nativeQueueCircuitBlocks(64 * 1024, now, circuitUntil)).toBe(false);
  });

  it("passes the managed CDN egress into the real Gateway child", () => {
    expect(validatedWeixinCdnChildEnvironment({
      WEIXIN_CDN_PRIMARY_METHOD: "POST",
      WEIXIN_CDN_PRIMARY_URL_SOURCE: "full",
      WEIXIN_CDN_SOCKS_PROXY: "socks5h://127.0.0.1:19080",
    })).toEqual({
      WEIXIN_CDN_PRIMARY_METHOD: "POST",
      WEIXIN_CDN_PRIMARY_URL_SOURCE: "full",
      WEIXIN_CDN_SOCKS_PROXY: "socks5h://127.0.0.1:19080",
    });
    expect(() => validatedWeixinCdnChildEnvironment({
      WEIXIN_CDN_PRIMARY_METHOD: "POST",
      WEIXIN_CDN_PRIMARY_URL_SOURCE: "full",
    })).toThrow("managed loopback tunnel");
    expect(() => validatedWeixinCdnChildEnvironment({
      WEIXIN_CDN_PRIMARY_METHOD: "POST",
      WEIXIN_CDN_PRIMARY_URL_SOURCE: "full",
      WEIXIN_CDN_SOCKS_PROXY: "socks5h://192.0.2.1:19080",
    })).toThrow("managed loopback tunnel");
  });
});

describe("work-file policy", () => {
  it("accepts an allowlisted image and records a SHA-256", async () => {
    const root = await fixture();
    const file = path.join(root, "safe.png");
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    const inspected = await inspectWorkFile(file, { allowedRoots: [root] });
    expect(inspected.mime).toBe("image/png");
    expect(inspected.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("blocks traversal roots, symlinks, hardlinks, sensitive names and executables", async () => {
    const root = await fixture();
    const other = await fixture();
    const png = path.join(other, "outside.png");
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    await expect(inspectWorkFile(png, { allowedRoots: [root] })).rejects.toThrow(/outside/);
    const link = path.join(root, "link.png");
    await symlink(png, link);
    await expect(inspectWorkFile(link, { allowedRoots: [root] })).rejects.toThrow(/regular non-symlink/);
    const secret = path.join(root, ".env");
    await writeFile(secret, "PASSWORD=not-a-real-secret-value\n");
    await expect(inspectWorkFile(secret, { allowedRoots: [root] })).rejects.toThrow(/blocked|allowlist/);
    const executable = path.join(root, "payload.exe");
    await writeFile(executable, Buffer.from("MZpayload"));
    await expect(inspectWorkFile(executable, { allowedRoots: [root] })).rejects.toThrow(/blocked|allowlist/);
  });

  it("rejects files over 50 MiB", async () => {
    const root = await fixture();
    const file = path.join(root, "large.pdf");
    await writeFile(file, "%PDF-1.7\n");
    await truncate(file, MAX_WORK_FILE_BYTES + 1);
    await expect(inspectWorkFile(file, { allowedRoots: [root] })).rejects.toThrow(/between 1 byte/);
  });

  it("rejects archive path traversal and credential-like entries", async () => {
    const root = await fixture();
    const traversal = path.join(root, "traversal.zip");
    await writeFile(traversal, storedZip([{ name: "../escape.txt", data: "safe" }]));
    await expect(inspectWorkFile(traversal, { allowedRoots: [root] })).rejects.toThrow(/unsafe entry path/);
    const secret = path.join(root, "documents.zip");
    await writeFile(secret, storedZip([{ name: "credentials.txt", data: "placeholder" }]));
    await expect(inspectWorkFile(secret, { allowedRoots: [root] })).rejects.toThrow(/credential-like filename/);
  });

  it("quarantines macro-enabled Office packages", async () => {
    const root = await fixture();
    const file = path.join(root, "macro.docm");
    await writeFile(file, storedZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "word/document.xml", data: "<w:document/>" },
      { name: "word/vbaProject.bin", data: "macro" },
    ]));
    await expect(inspectWorkFile(file, { allowedRoots: [root] })).rejects.toThrow(/quarantine/);
  });

  it("imports only validated generated images into a managed workspace directory", async () => {
    const generated = await fixture();
    const workspace = await fixture();
    const source = path.join(generated, "generated.png");
    await writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    const imported = await importGeneratedImage(source, {
      generatedRoot: generated,
      destinationRoot: path.join(workspace, "media", "outbound", "imported-generated"),
      name: "cover.png",
    });
    expect(imported.path).toContain(`${path.sep}imported-generated${path.sep}`);
    expect(imported.file.sha256).toBe((await inspectWorkFile(source, { allowedRoots: [generated] })).sha256);
    expect(imported.reused).toBe(false);
    const reused = await importGeneratedImage(source, {
      generatedRoot: generated,
      destinationRoot: path.join(workspace, "media", "outbound", "imported-generated"),
      name: "cover.png",
    });
    expect(reused.reused).toBe(true);
  });

  it("rejects generated-image imports from outside the generated root and unsafe names", async () => {
    const generated = await fixture();
    const outside = await fixture();
    const workspace = await fixture();
    const source = path.join(outside, "outside.png");
    await writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    await expect(importGeneratedImage(source, {
      generatedRoot: generated,
      destinationRoot: workspace,
    })).rejects.toThrow(/outside/);
    const inside = path.join(generated, "inside.png");
    await writeFile(inside, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    await expect(importGeneratedImage(inside, {
      generatedRoot: generated,
      destinationRoot: workspace,
      name: "../escape.png",
    })).rejects.toThrow(/plain safe filename/);
  });
});

describe("safe Office extraction", () => {
  it("extracts DOCX text without executing embedded content", async () => {
    const root = await fixture();
    const file = path.join(root, "report.docx");
    await writeFile(file, storedZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "word/document.xml", data: "<w:document><w:body><w:p><w:r><w:t>季度报告</w:t></w:r></w:p><w:p><w:r><w:t>完成</w:t></w:r></w:p></w:body></w:document>" },
    ]));
    const result = await extractWorkFile(file, { allowedRoots: [root] });
    expect(result.text).toContain("季度报告");
    expect(result.text).toContain("完成");
  });

  it("extracts a selected XLSX worksheet and cell range", async () => {
    const root = await fixture();
    const file = path.join(root, "table.xlsx");
    await writeFile(file, storedZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "xl/workbook.xml", data: '<workbook><sheets><sheet name="工作表1" r:id="rId1"/></sheets></workbook>' },
      { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
      { name: "xl/sharedStrings.xml", data: "<sst><si><t>姓名</t></si><si><t>小明</t></si></sst>" },
      { name: "xl/worksheets/sheet1.xml", data: '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>' },
    ]));
    const result = await extractWorkFile(file, { allowedRoots: [root], sheet: "工作表1", cellRange: "A1:A2" });
    expect(result.text).toContain("A1\t姓名");
    expect(result.text).toContain("A2\t小明");
  });
});
