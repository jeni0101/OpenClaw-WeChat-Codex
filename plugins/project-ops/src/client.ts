import { request } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface Actor {
  senderId: string;
  channel: string;
  senderIsOwner: boolean;
}
let cachedToken: string | undefined;

async function brokerToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (process.env.PROJECT_OPS_BROKER_TOKEN) {
    cachedToken = process.env.PROJECT_OPS_BROKER_TOKEN.trim();
    return cachedToken;
  }
  const explicit = process.env.PROJECT_OPS_BROKER_TOKEN_FILE;
  const credentialDir = process.env.CREDENTIALS_DIRECTORY;
  const file = explicit ?? (credentialDir ? path.join(credentialDir, "broker-token") : undefined);
  if (!file) throw new Error("project-ops broker credential is not configured");
  cachedToken = (await readFile(file, "utf8")).trim();
  return cachedToken;
}

export async function callBroker<T>(route: string, body: Record<string, unknown>): Promise<T> {
  const socketPath = process.env.PROJECT_OPS_SOCKET ?? "/opt/WeChat-Open in/data/run/project-ops.sock";
  const token = await brokerToken();
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
      timeout: 60_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy(new Error("project-ops response exceeded 2 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      res.once("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as T & { error?: { message?: string } };
          if ((res.statusCode ?? 500) >= 400) throw new Error(parsed.error?.message ?? `broker returned ${res.statusCode}`);
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.once("timeout", () => req.destroy(new Error("project-ops broker timed out")));
    req.once("error", reject);
    req.end(encoded);
  });
}
