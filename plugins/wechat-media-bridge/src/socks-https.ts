import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

export interface LoopbackSocksProxy {
  host: "127.0.0.1" | "::1";
  port: number;
}

export function parseLoopbackSocksProxy(value: string | undefined): LoopbackSocksProxy | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = new URL(trimmed);
  const host = parsed.hostname === "[::1]" ? "::1" : parsed.hostname;
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "socks5h:"
    || (host !== "127.0.0.1" && host !== "::1")
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || parsed.username
    || parsed.password
    || (parsed.pathname !== "" && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("WEIXIN_CDN_SOCKS_PROXY must be an unauthenticated loopback socks5h URL");
  }
  return { host, port };
}

function targetHost(options: https.RequestOptions): string {
  const value = options.servername
    || options.hostname
    || (typeof options.host === "string" ? options.host : undefined);
  if (!value || value.length > 255 || !/^[A-Za-z0-9.-]+$/.test(value)) {
    throw new Error("invalid SOCKS target hostname");
  }
  return value;
}

function targetPort(options: https.RequestOptions): number {
  const value = Number(options.port ?? 443);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("invalid SOCKS target port");
  }
  return value;
}

export async function connectThroughSocks(
  proxy: LoopbackSocksProxy,
  hostname: string,
  port: number,
  timeoutMs = 15_000,
): Promise<net.Socket> {
  if (!hostname || hostname.length > 255 || !/^[A-Za-z0-9.-]+$/.test(hostname)) {
    throw new Error("invalid SOCKS target hostname");
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid SOCKS target port");
  }

  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ host: proxy.host, port: proxy.port });
    let settled = false;
    let stage: "greeting" | "connect" = "greeting";
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      finish(new Error("SOCKS proxy handshake timed out"));
    }, timeoutMs);
    timer.unref();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      if (buffered.length > 0) socket.unshift(buffered);
      resolve(socket);
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("SOCKS proxy closed during handshake"));
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      if (stage === "greeting") {
        if (buffered.length < 2) return;
        const version = buffered[0];
        const method = buffered[1];
        buffered = buffered.subarray(2);
        if (version !== 0x05 || method !== 0x00) {
          finish(new Error("SOCKS proxy rejected unauthenticated negotiation"));
          return;
        }
        const hostBytes = Buffer.from(hostname, "ascii");
        const request = Buffer.alloc(7 + hostBytes.length);
        request[0] = 0x05;
        request[1] = 0x01;
        request[2] = 0x00;
        request[3] = 0x03;
        request[4] = hostBytes.length;
        hostBytes.copy(request, 5);
        request.writeUInt16BE(port, 5 + hostBytes.length);
        stage = "connect";
        socket.write(request);
      }
      if (stage === "connect") {
        if (buffered.length < 5) return;
        const addressType = buffered[3];
        const addressLength = addressType === 0x01
          ? 4
          : addressType === 0x04
            ? 16
            : addressType === 0x03
              ? 1 + buffered[4]!
              : -1;
        if (addressLength < 0) {
          finish(new Error("SOCKS proxy returned an invalid address type"));
          return;
        }
        const replyLength = 4 + addressLength + 2;
        if (buffered.length < replyLength) return;
        const version = buffered[0];
        const status = buffered[1];
        buffered = buffered.subarray(replyLength);
        if (version !== 0x05 || status !== 0x00) {
          finish(new Error(`SOCKS proxy connect failed with status ${status ?? -1}`));
          return;
        }
        finish();
      }
    };

    socket.once("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export class SocksHttpsAgent extends https.Agent {
  constructor(
    private readonly proxy: LoopbackSocksProxy,
  ) {
    super({
      keepAlive: true,
      maxSockets: 8,
      maxFreeSockets: 2,
      timeout: 90_000,
    });
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const done = callback ?? (() => undefined);
    let hostname: string;
    let port: number;
    try {
      hostname = targetHost(options);
      port = targetPort(options);
    } catch (error) {
      queueMicrotask(() => done(error instanceof Error ? error : new Error(String(error)), null as unknown as Duplex));
      return undefined;
    }

    void connectThroughSocks(this.proxy, hostname, port).then((socket) => {
      const secure = tls.connect({
        socket,
        servername: hostname,
        rejectUnauthorized: options.rejectUnauthorized !== false,
        ...(options.ca ? { ca: options.ca } : {}),
        ...(options.cert ? { cert: options.cert } : {}),
        ...(options.key ? { key: options.key } : {}),
        ...(options.ciphers ? { ciphers: options.ciphers } : {}),
        ...(options.minVersion ? { minVersion: options.minVersion } : {}),
        ...(options.maxVersion ? { maxVersion: options.maxVersion } : {}),
      });
      const fail = (error: Error) => {
        secure.destroy();
        done(error, secure);
      };
      secure.once("error", fail);
      secure.once("secureConnect", () => {
        secure.removeListener("error", fail);
        done(null, secure);
      });
    }).catch((error: unknown) => {
      done(error instanceof Error ? error : new Error(String(error)), null as unknown as Duplex);
    });
    return undefined;
  }
}
