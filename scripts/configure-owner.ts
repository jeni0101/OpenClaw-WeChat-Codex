import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../src/ops/process.js";

async function listJsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function main(): Promise<void> {
  const projectRoot = "/opt/WeChat-Open in";
  const credentialsDir = path.join(projectRoot, "data", "state", "credentials");
  const accountDir = path.join(projectRoot, "data", "state", "openclaw-weixin", "accounts");
  const candidates = (await listJsonFiles(credentialsDir)).filter((name) => /^openclaw-weixin-.*-allowFrom\.json$/.test(name));
  const owners = new Set<string>();
  for (const name of candidates) {
    const parsed = JSON.parse(await readFile(path.join(credentialsDir, name), "utf8")) as { allowFrom?: unknown };
    if (Array.isArray(parsed.allowFrom)) {
      for (const value of parsed.allowFrom) if (typeof value === "string" && value.trim()) owners.add(value.trim());
    }
  }

  // Tencent's current Weixin plugin records the user who scanned the login QR
  // in the account file and uses that value as the legacy allowlist fallback.
  // Accept it here so fresh installations can freeze the same identity into a
  // systemd credential before a separate framework allowFrom file exists.
  const accountFiles = (await listJsonFiles(accountDir)).filter(
    (name) => !name.endsWith(".sync.json") && !name.endsWith(".context-tokens.json"),
  );
  for (const name of accountFiles) {
    const parsed = JSON.parse(await readFile(path.join(accountDir, name), "utf8")) as { userId?: unknown };
    if (typeof parsed.userId === "string" && parsed.userId.trim()) owners.add(parsed.userId.trim());
  }

  if (owners.size !== 1) throw new Error(`expected exactly one paired WeChat owner, found ${owners.size}`);
  const temporary = path.join(projectRoot, "data", "tmp", `.owner-${process.pid}`);
  await writeFile(temporary, [...owners][0]!, { mode: 0o600, flag: "wx" });
  try {
    const result = await runCommand([
      "/usr/bin/sudo", "/usr/bin/systemd-creds", "encrypt", "--name=owner-wechat-id", temporary,
      "/etc/credstore.encrypted/wechat-clawbot-owner-wechat-id.cred",
    ], { maxOutputBytes: 32 * 1024, timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(`systemd-creds failed: ${result.stderr}`);
    await chmod("/etc/credstore.encrypted/wechat-clawbot-owner-wechat-id.cred", 0o600);
  } finally {
    await writeFile(temporary, "x".repeat(Buffer.byteLength([...owners][0]!)), { mode: 0o600 }).catch(() => undefined);
    const cleanup = await runCommand(["/usr/bin/unlink", temporary], { maxOutputBytes: 1024 });
    if (cleanup.code !== 0) throw new Error("failed to remove temporary owner credential");
  }
  process.stdout.write("Owner credential configured from the single WeChat pairing record.\n");
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
