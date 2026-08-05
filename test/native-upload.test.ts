import crypto from "node:crypto";
import http, { type Server } from "node:http";
import net from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aesEcbPaddedSize,
  executeUploadStrategy,
  NativeUploadError,
  type StreamUploadResponse,
  uploadEncryptedFile,
  uploadMethodSequence,
  uploadTimeoutMs,
  verifyUploadSource,
} from "../plugins/wechat-media-bridge/src/native-upload.js";
import {
  connectThroughSocks,
  parseLoopbackSocksProxy,
} from "../plugins/wechat-media-bridge/src/socks-https.js";

const roots: string[] = [];
const servers: Array<Server | net.Server> = [];

async function fixtureFile(data: Buffer): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wechat-native-upload-test-"));
  roots.push(root);
  const file = path.join(root, "fixture.bin");
  await writeFile(file, data);
  return file;
}

async function listen(handler: http.RequestListener): Promise<{ server: Server; url: URL }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
  return { server, url: new URL(`http://127.0.0.1:${address.port}/upload`) };
}

function response(status: number, downloadParam?: string): StreamUploadResponse {
  return {
    status,
    responseHeaders: {},
    responseBytes: 0,
    responseSha256: crypto.createHash("sha256").digest("hex"),
    timingsMs: {},
    ...(downloadParam ? { downloadParam } : {}),
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("native Weixin streaming upload", () => {
  it("accepts only unauthenticated loopback SOCKS5h proxies", () => {
    expect(parseLoopbackSocksProxy("socks5h://127.0.0.1:19080")).toEqual({
      host: "127.0.0.1",
      port: 19080,
    });
    expect(() => parseLoopbackSocksProxy("socks5://127.0.0.1:19080")).toThrow();
    expect(() => parseLoopbackSocksProxy("socks5h://user:pass@127.0.0.1:19080")).toThrow();
    expect(() => parseLoopbackSocksProxy("socks5h://192.0.2.1:19080")).toThrow();
  });

  it("negotiates a domain-name SOCKS5 connection", async () => {
    let requestedHost = "";
    let requestedPort = 0;
    const proxy = net.createServer((socket) => {
      let stage = 0;
      socket.on("data", (chunk) => {
        if (stage === 0) {
          expect(Buffer.from(chunk)).toEqual(Buffer.from([0x05, 0x01, 0x00]));
          stage = 1;
          socket.write(Buffer.from([0x05, 0x00]));
          return;
        }
        const request = Buffer.from(chunk);
        expect(request.subarray(0, 5)).toEqual(Buffer.from([0x05, 0x01, 0x00, 0x03, 0x0b]));
        requestedHost = request.subarray(5, 16).toString("ascii");
        requestedPort = request.readUInt16BE(16);
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      });
    });
    servers.push(proxy);
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("SOCKS test proxy did not expose a port");
    const socket = await connectThroughSocks(
      { host: "127.0.0.1", port: address.port },
      "example.com",
      443,
    );
    expect(requestedHost).toBe("example.com");
    expect(requestedPort).toBe(443);
    socket.destroy();
  });

  it("calculates ciphertext sizes, adaptive timeouts and alternating methods", () => {
    expect(aesEcbPaddedSize(0)).toBe(16);
    expect(aesEcbPaddedSize(15)).toBe(16);
    expect(aesEcbPaddedSize(16)).toBe(32);
    expect(aesEcbPaddedSize(50 * 1024 * 1024)).toBe(50 * 1024 * 1024 + 16);
    expect(uploadTimeoutMs(64 * 1024)).toBe(122_000);
    expect(uploadTimeoutMs(16 * 1024 * 1024)).toBe(632_000);
    expect(uploadTimeoutMs(50 * 1024 * 1024)).toBe(1_720_000);
    expect(uploadMethodSequence("POST")).toEqual(["POST", "PUT", "POST", "PUT"]);
    expect(uploadMethodSequence("PUT", 3)).toEqual(["PUT", "POST", "PUT"]);
  });

  it.each(["POST", "PUT"] as const)(
    "streams encrypted bytes with fixed Content-Length over %s",
    async (method) => {
      const plaintext = crypto.randomBytes(512 * 1024 + 7);
      const aesKey = crypto.randomBytes(16);
      let receivedMethod = "";
      let receivedLength = "";
      let transferEncoding: string | undefined;
      let ciphertext = Buffer.alloc(0);
      const { url } = await listen((request, reply) => {
        receivedMethod = request.method ?? "";
        receivedLength = request.headers["content-length"] ?? "";
        transferEncoding = request.headers["transfer-encoding"];
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          ciphertext = Buffer.concat(chunks);
          reply.writeHead(200, { "X-Encrypted-Param": "download-parameter" });
          reply.end();
        });
      });
      const file = await fixtureFile(plaintext);
      const expectedSha256 = crypto.createHash("sha256").update(plaintext).digest("hex");
      const source = await verifyUploadSource(file, plaintext.length, expectedSha256);
      const result = await uploadEncryptedFile({
        filePath: file,
        source,
        aesKey,
        method,
        url,
        requestImpl: (target, options, callback) => http.request(target, options, callback),
      });

      const decipher = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
      decipher.setAutoPadding(true);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      expect(receivedMethod).toBe(method);
      expect(receivedLength).toBe(String(aesEcbPaddedSize(plaintext.length)));
      expect(transferEncoding).toBeUndefined();
      expect(ciphertext).toHaveLength(aesEcbPaddedSize(plaintext.length));
      expect(decrypted.equals(plaintext)).toBe(true);
      expect(result.downloadParam).toBe("download-parameter");
      expect(result.requestBody).toMatchObject({
        plaintextReadBytes: plaintext.length,
        ciphertextProducedBytes: aesEcbPaddedSize(plaintext.length),
        contentLength: aesEcbPaddedSize(plaintext.length),
        requestWritableEnded: true,
        requestWritableFinished: true,
      });
    },
  );

  it("redacts and bounds CDN error response bodies", async () => {
    const secret = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz";
    const { url } = await listen((_request, reply) => {
      reply.writeHead(500, { "Content-Type": "text/plain" });
      reply.end(`token=${secret} https://example.invalid/private?token=${secret}`);
    });
    const plaintext = Buffer.from("safe fixture");
    const file = await fixtureFile(plaintext);
    const source = await verifyUploadSource(
      file,
      plaintext.length,
      crypto.createHash("sha256").update(plaintext).digest("hex"),
    );
    const result = await uploadEncryptedFile({
      filePath: file,
      source,
      aesKey: crypto.randomBytes(16),
      method: "POST",
      url,
      requestImpl: (target, options, callback) => http.request(target, options, callback),
    });
    expect(result.status).toBe(500);
    expect(result.errorBodyPreview).toContain("<redacted");
    expect(result.errorBodyPreview).not.toContain(secret);
    expect(result.errorBodyPreview!.length).toBeLessThanOrEqual(1024);
  });

  it("preserves an early CDN error response when the server closes before consuming the body", async () => {
    const { url } = await listen((_request, reply) => {
      reply.writeHead(500, { "Content-Length": "0" });
      reply.end();
    });
    const plaintext = crypto.randomBytes(4 * 1024 * 1024);
    const file = await fixtureFile(plaintext);
    const source = await verifyUploadSource(
      file,
      plaintext.length,
      crypto.createHash("sha256").update(plaintext).digest("hex"),
    );
    const result = await uploadEncryptedFile({
      filePath: file,
      source,
      aesKey: crypto.randomBytes(16),
      method: "POST",
      url,
      requestImpl: (target, options, callback) => http.request(target, options, callback),
    });

    expect(result.status).toBe(500);
    expect(result.downloadParam).toBeUndefined();
    expect(result.requestBody?.contentLength).toBe(aesEcbPaddedSize(plaintext.length));
    expect(result.requestBody?.plaintextReadBytes).toBeLessThanOrEqual(plaintext.length);
    expect(result.requestBody?.ciphertextProducedBytes).toBeLessThanOrEqual(aesEcbPaddedSize(plaintext.length));
  });

  it("uses a fresh task and alternate method after 5xx or a missing receipt", async () => {
    const acquired: Array<{ attempt: number; method: string; nonce: symbol }> = [];
    const events: Array<{ attempt: number; errorCode?: string }> = [];
    const delays: number[] = [];
    const replies = [response(500), response(200), response(200, "ok")];
    const result = await executeUploadStrategy({
      methods: uploadMethodSequence("POST", 3),
      async acquire(method, attempt) {
        const ticket = { attempt, method, nonce: Symbol(String(attempt)) };
        acquired.push(ticket);
        return ticket;
      },
      async upload(_ticket, _method, attempt) {
        return replies[attempt - 1]!;
      },
      onAttempt(event) {
        events.push({ attempt: event.attempt, ...(event.errorCode ? { errorCode: event.errorCode } : {}) });
      },
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(acquired.map(({ attempt, method }) => ({ attempt, method }))).toEqual([
      { attempt: 1, method: "POST" },
      { attempt: 2, method: "PUT" },
      { attempt: 3, method: "POST" },
    ]);
    expect(new Set(acquired.map((item) => item.nonce)).size).toBe(3);
    expect(events).toEqual([
      { attempt: 1, errorCode: "WEIXIN_CDN_5XX" },
      { attempt: 2, errorCode: "WEIXIN_CDN_PROTOCOL" },
      { attempt: 3 },
    ]);
    expect(delays).toEqual([5_000, 15_000]);
    expect(result.attempt).toBe(3);
    expect(result.response.downloadParam).toBe("ok");
  });

  it("does not retry a CDN 4xx response", async () => {
    let acquired = 0;
    await expect(executeUploadStrategy({
      methods: uploadMethodSequence("POST"),
      async acquire() {
        acquired += 1;
        return {};
      },
      async upload() {
        return response(403);
      },
      delay: async () => undefined,
    })).rejects.toMatchObject({ code: "WEIXIN_CDN_4XX" });
    expect(acquired).toBe(1);
  });

  it("blocks an upload when the verified source changes", async () => {
    const original = Buffer.from("original source");
    const file = await fixtureFile(original);
    const source = await verifyUploadSource(
      file,
      original.length,
      crypto.createHash("sha256").update(original).digest("hex"),
    );
    await writeFile(file, Buffer.from("modified source"));
    const requestImpl = () => {
      throw new Error("network request must not start");
    };
    await expect(uploadEncryptedFile({
      filePath: file,
      source,
      aesKey: crypto.randomBytes(16),
      method: "POST",
      url: new URL("https://novac2c.cdn.weixin.qq.com/c2c/upload"),
      requestImpl,
    })).rejects.toBeInstanceOf(NativeUploadError);
  });
});
