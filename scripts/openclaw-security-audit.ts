import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../src/ops/process.js";

async function main(): Promise<void> {
  const mode = process.argv.includes("--deep") ? "deep" : "static";
  const projectRoot = "/opt/WeChat-Open in";
  const dataDir = path.join(projectRoot, "data");
  const credentialDir = process.env.CREDENTIALS_DIRECTORY;
  if (!credentialDir) throw new Error("systemd credential directory is required");
  const gatewayToken = (await readFile(path.join(credentialDir, "gateway-token"), "utf8")).trim();
  if (gatewayToken.length < 24) throw new Error("gateway credential is missing or too short");
  const result = await runCommand([
    process.execPath,
    path.join(projectRoot, "node_modules", "openclaw", "openclaw.mjs"),
    "security", "audit", ...(mode === "deep" ? ["--deep"] : []), "--json",
  ], {
    timeoutMs: mode === "deep" ? 5 * 60_000 : 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
    env: {
      PATH: `${path.join(dataDir, "node", "bin")}:/usr/sbin:/usr/bin:/sbin:/bin`,
      LANG: "C.UTF-8",
      HOME: path.join(dataDir, "home"),
      OPENCLAW_STATE_DIR: path.join(dataDir, "state"),
      OPENCLAW_CONFIG_PATH: path.join(projectRoot, "config", "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    },
  });
  const safe = `${result.stdout}\n${result.stderr}`
    .replaceAll(gatewayToken, "[REDACTED]")
    .replace(/(token|secret|password|authorization)\s*[=:]\s*\S+/gi, "$1=[REDACTED]");
  process.stdout.write(safe.trimEnd() + "\n");
  if (result.code !== 0 || result.timedOut || result.truncated) process.exitCode = 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
  process.exitCode = 1;
});
