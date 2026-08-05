import { request } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

export class MediaBridgeError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 500) {
    super(message);
    this.name = "MediaBridgeError";
  }
}

let cachedToken: string | undefined;

async function bridgeToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const explicit = process.env.MEDIA_BRIDGE_TOKEN_FILE ?? process.env.PROJECT_OPS_BROKER_TOKEN_FILE;
  const credentialDir = process.env.CREDENTIALS_DIRECTORY;
  const file = explicit ?? (credentialDir ? path.join(credentialDir, "broker-token") : undefined);
  if (!file) throw new MediaBridgeError("NOT_CONFIGURED", "media bridge credential is not configured", 503);
  cachedToken = (await readFile(file, "utf8")).trim();
  if (cachedToken.length < 24) throw new MediaBridgeError("NOT_CONFIGURED", "media bridge credential is invalid", 503);
  return cachedToken;
}

export async function callMediaBridge<T>(route: string, body: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
  const socketPath = process.env.MEDIA_BRIDGE_SOCKET ?? "/opt/WeChat-Open in/data/run/media-bridge.sock";
  const token = await bridgeToken();
  const encoded = Buffer.from(JSON.stringify(body));
  return await new Promise<T>((resolve, reject) => {
    const req = request({
      socketPath,
      path: route,
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": encoded.length,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy(new MediaBridgeError("RESPONSE_TOO_LARGE", "media bridge response exceeded 2 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      res.once("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as T & { error?: { code?: string; message?: string } };
          const status = res.statusCode ?? 500;
          if (status >= 400) throw new MediaBridgeError(parsed.error?.code ?? "BRIDGE_ERROR", parsed.error?.message ?? `media bridge returned ${status}`, status);
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.once("timeout", () => req.destroy(new MediaBridgeError("TIMEOUT", "media bridge timed out", 504)));
    req.once("error", (error) => {
      if (error instanceof MediaBridgeError) reject(error);
      else reject(new MediaBridgeError("UNAVAILABLE", "media bridge is unavailable", 503));
    });
    req.end(encoded);
  });
}
