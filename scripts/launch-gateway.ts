import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validatedWeixinCdnChildEnvironment } from "../src/weixin-cdn-env.js";

const projectRoot = process.env.WECHAT_CLAWBOT_ROOT ?? "/opt/WeChat-Open in";
const dataDir = process.env.WECHAT_CLAWBOT_DATA ?? path.join(projectRoot, "data");
const credentialDir = process.env.CREDENTIALS_DIRECTORY;
if (!credentialDir) throw new Error("systemd credential directory is required");
const gatewayToken = (await readFile(path.join(credentialDir, "gateway-token"), "utf8")).trim();
if (gatewayToken.length < 24) throw new Error("gateway token is missing or too short");
const weixinCdnEnvironment = validatedWeixinCdnChildEnvironment(process.env);

const child = spawn(process.execPath, [
  path.join(projectRoot, "node_modules", "openclaw", "openclaw.mjs"),
  "gateway",
  "run",
  "--ws-log",
  "compact",
], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: false,
  env: {
    PATH: `${path.join(dataDir, "node", "bin")}:/usr/sbin:/usr/bin:/sbin:/bin`,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HOME: path.join(dataDir, "home"),
    TMPDIR: path.join(dataDir, "tmp"),
    OPENCLAW_STATE_DIR: path.join(dataDir, "state"),
    OPENCLAW_CONFIG_PATH: path.join(projectRoot, "config", "openclaw.json"),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    // Use the read-only stable bind path. Codex network profiles execute a
    // child of this binary inside bubblewrap, where project runtime paths are
    // intentionally not visible.
    OPENCLAW_CODEX_APP_SERVER_BIN: "/usr/local/libexec/wechat-clawbot-codex/bin/codex",
    OPENCLAW_LOG_LEVEL: "warn",
    CREDENTIALS_DIRECTORY: credentialDir,
    WECHAT_OWNER_ID_FILE: path.join(credentialDir, "owner-wechat-id"),
    MEDIA_BRIDGE_SOCKET: path.join(dataDir, "run", "media-bridge.sock"),
    MEDIA_BRIDGE_TOKEN_FILE: path.join(credentialDir, "broker-token"),
    PROJECT_OPS_SOCKET: path.join(dataDir, "run", "project-ops.sock"),
    PROJECT_OPS_BROKER_TOKEN_FILE: path.join(credentialDir, "broker-token"),
    ...weixinCdnEnvironment,
    PYTHONPATH: path.join(dataDir, "tools", "python-pptx"),
    NODE_OPTIONS: "--max-old-space-size=896",
  },
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  process.stderr.write(`${JSON.stringify({ level: "error", event: "gateway.spawn_failed", error: String(error) })}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
