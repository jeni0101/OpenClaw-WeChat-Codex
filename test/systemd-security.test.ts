import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveServiceIdentity } from "../src/ops/identity.js";
import { runCommand } from "../src/ops/process.js";

function directive(unit: string, name: string): string {
  const line = unit.split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`missing systemd directive: ${name}`);
  return line.slice(name.length + 1);
}

const EXPECTED_CAPABILITIES = [
  "CAP_CHOWN",
  "CAP_DAC_OVERRIDE",
  "CAP_FOWNER",
  "CAP_SETUID",
  "CAP_SETGID",
];
const EXPECTED_CAPABILITY_HEX = "00000000000000cb";
const EXPECTED_AMBIENT_HEX = "00000000000000c0";

function statusFields(value: string): Record<string, string> {
  return Object.fromEntries(
    value.split(/\r?\n/)
      .filter((line) => /^(?:CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):/.test(line))
      .map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator), line.slice(separator + 1).trim()];
      }),
  );
}

describe("ops systemd security boundary", () => {
  it("allows only the exact capabilities required for staging and fixed identity drop", async () => {
    const unit = await readFile(
      path.join(process.cwd(), "deploy/systemd/wechat-clawbot-ops.service"),
      "utf8",
    );
    expect(directive(unit, "CapabilityBoundingSet").split(/\s+/)).toEqual(EXPECTED_CAPABILITIES);
    expect(directive(unit, "AmbientCapabilities").split(/\s+/)).toEqual([
      "CAP_SETUID",
      "CAP_SETGID",
    ]);
    expect(directive(unit, "NoNewPrivileges")).toBe("yes");
    expect(unit).toContain(
      "Environment=\"WECHAT_CLAWBOT_CODEX_RUNNER=/opt/WeChat-Open in/dist/src/ops/codex-runner.js\"",
    );
    expect(unit).not.toMatch(/^Environment=.*(?:OPENAI_API_KEY|CODEX_API_KEY)/m);
    expect(directive(unit, "PrivateDevices")).toBe("yes");
    expect(directive(unit, "PrivateTmp")).toBe("yes");
    expect(directive(unit, "ProtectSystem")).toBe("strict");
    expect(directive(unit, "ProtectHome")).toBe("read-only");
    expect(directive(unit, "RestrictAddressFamilies")).toBe("AF_UNIX AF_INET AF_INET6 AF_NETLINK");
    expect(directive(unit, "ReadWritePaths")).toBe(
      "\"/opt/WeChat-Open in/data\" -/srv/wechat-clawbot/projects/example",
    );
  });

  it.runIf(process.getuid?.() === 0)(
    "lets the fixed service identity inspect an isolated Git clone without live-home access",
    async () => {
      const serviceIdentity = await resolveServiceIdentity();
      const source = await mkdtemp("/opt/WeChat-Open in/data/tmp/project-ops-source-");
      const stage = await mkdtemp("/opt/WeChat-Open in/data/tmp/project-ops-git-");
      const bundle = `${stage}.bundle`;
      await rm(stage, { recursive: true, force: true });
      try {
        expect((await runCommand(["/usr/bin/git", "init", "--quiet", source])).code).toBe(0);
        await writeFile(path.join(source, "README.md"), "isolated fixture\n", "utf8");
        expect((await runCommand([
          "/usr/bin/git", "-C", source, "add", "README.md",
        ])).code).toBe(0);
        expect((await runCommand([
          "/usr/bin/git", "-c", "user.name=fixture", "-c", "user.email=fixture@invalid",
          "-C", source, "commit", "--quiet", "-m", "fixture",
        ])).code).toBe(0);
        const bundled = await runCommand([
          "/usr/bin/git",
          "-c", `safe.directory=${source}`,
          "-C", source,
          "bundle", "create", bundle, "HEAD",
        ], { timeoutMs: 120_000 });
        expect(bundled.code, bundled.stderr).toBe(0);
        const cloned = await runCommand([
          "/usr/bin/git", "clone", "--no-tags", "--no-recurse-submodules", bundle, stage,
        ], { timeoutMs: 120_000 });
        expect(cloned.code, cloned.stderr).toBe(0);
        expect((await stat(path.join(stage, ".git"))).isDirectory()).toBe(true);
        expect((await runCommand([
          "/usr/bin/chown", "-R", `${serviceIdentity.uid}:${serviceIdentity.gid}`, stage,
        ])).code).toBe(0);
        const status = await runCommand([
          "/usr/bin/git", "-c", `safe.directory=${stage}`, "-C", stage, "status", "--short",
        ], {
          uid: serviceIdentity.uid,
          gid: serviceIdentity.gid,
          env: {
            PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
          },
        });
        expect(status).toMatchObject({ code: 0, signal: null, stdout: "" });
      } finally {
        await rm(source, { recursive: true, force: true });
        await rm(stage, { recursive: true, force: true });
        await rm(bundle, { force: true });
      }
    },
  );

  it("takes the Codex uid and gid only from the broker-resolved service identity", async () => {
    const [broker, staging] = await Promise.all([
      readFile(path.join(process.cwd(), "src/ops/broker.ts"), "utf8"),
      readFile(path.join(process.cwd(), "src/ops/staging.ts"), "utf8"),
    ]);
    expect(broker).toContain("serviceUid: serviceIdentity.uid");
    expect(broker).toContain("serviceGid: serviceIdentity.gid");
    expect(broker).not.toMatch(/service(?:Uid|Gid):\s*(?:body|params|rawParams|request)\b/);
    expect(staging).toContain("uid: options.serviceUid");
    expect(staging).toContain("gid: options.serviceGid");
    expect(staging).not.toMatch(/(?:uid|gid):\s*(?:body|params|rawParams|request)\b/);
  });

  it.runIf(process.getuid?.() === 0)(
    "retains effective identity-drop capabilities and spawns real children inside the hardened unit boundary",
    async () => {
      const serviceIdentity = await resolveServiceIdentity();
      const unitName = `wechat-clawbot-capability-test-${randomUUID()}`;
      const probe = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "const status = Object.fromEntries(fs.readFileSync('/proc/self/status', 'utf8')",
        "  .split('\\n').filter((line) => /^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):/.test(line))",
        "  .map((line) => { const separator = line.indexOf(':');",
        "    return [line.slice(0, separator), line.slice(separator + 1).trim()]; }));",
        "console.log(JSON.stringify({ name: 'parent', status }));",
        `const env = { PATH: '${path.dirname(process.execPath)}:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',`,
        "  HOME: '/opt/WeChat-Open in/data/state/codex', CODEX_HOME: '/opt/WeChat-Open in/data/state/codex',",
        "  TMPDIR: '/opt/WeChat-Open in/data/tmp' };",
        "function run(name, file, args, ids) { return new Promise((resolve) => {",
        "  let child; try { child = spawn(file, args, { cwd: '/opt/WeChat-Open in/data/tmp', env,",
        "    stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, ...ids });",
        "  } catch (error) { console.log(JSON.stringify({ name, phase: 'throw', code: error.code })); return resolve(); }",
        "  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; });",
        "  child.stderr.on('data', (chunk) => { stderr += chunk; });",
        "  child.once('error', (error) => { console.log(JSON.stringify({ name, phase: 'error', code: error.code })); resolve(); });",
        "  child.once('close', (code, signal) => { console.log(JSON.stringify({ name, phase: 'close', code, signal,",
        "    stdout: stdout.trim(), stderr: stderr.trim().slice(0, 200) })); resolve(); });",
        "}); }",
        "(async () => {",
        `  await run('uid-only', '/usr/bin/id', [], { uid: ${serviceIdentity.uid} });`,
        `  await run('uid-gid', '/usr/bin/id', [], { uid: ${serviceIdentity.uid}, gid: ${serviceIdentity.gid} });`,
        `  await run('codex-version', '/opt/WeChat-Open in/node_modules/.bin/codex', ['--version'], { uid: ${serviceIdentity.uid}, gid: ${serviceIdentity.gid} });`,
        "})().catch((error) => { console.error(error); process.exitCode = 1; });",
      ].join("\n");
      const result = await runCommand([
        "/usr/bin/systemd-run",
        "--pipe", "--wait", "--quiet", "--collect",
        `--unit=${unitName}`,
        "--uid=root",
        "--gid=wechat-clawbot",
        "--property=NoNewPrivileges=yes",
        "--property=PrivateTmp=yes",
        "--property=PrivateDevices=yes",
        "--property=ProtectSystem=strict",
        "--property=ProtectHome=read-only",
        "--property=ProtectKernelTunables=yes",
        "--property=ProtectKernelModules=yes",
        "--property=ProtectControlGroups=yes",
        "--property=ProtectClock=yes",
        "--property=RestrictSUIDSGID=yes",
        "--property=LockPersonality=yes",
        "--property=RestrictRealtime=yes",
        `--property=CapabilityBoundingSet=${EXPECTED_CAPABILITIES.join(" ")}`,
        "--property=AmbientCapabilities=CAP_SETUID CAP_SETGID",
        "--property=ReadWritePaths=\"/opt/WeChat-Open in/data\" -/srv/wechat-clawbot/projects/example",
        "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
        "--property=SystemCallArchitectures=native",
        "--property=OOMPolicy=continue",
        "--working-directory=/opt/WeChat-Open in",
        "/opt/WeChat-Open in/data/node/bin/node",
        "-e",
        probe,
      ], { timeoutMs: 120_000, maxOutputBytes: 64 * 1024 });
      expect(result).toMatchObject({ code: 0, signal: null, timedOut: false, truncated: false });
      const records = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
        name: string;
        status?: Record<string, string>;
        phase?: string;
        code?: number | null;
        signal?: string | null;
        stdout?: string;
      });
      const parent = records.find((record) => record.name === "parent");
      expect(parent?.status).toMatchObject({
        CapInh: EXPECTED_AMBIENT_HEX,
        CapPrm: EXPECTED_CAPABILITY_HEX,
        CapEff: EXPECTED_CAPABILITY_HEX,
        CapBnd: EXPECTED_CAPABILITY_HEX,
        CapAmb: EXPECTED_AMBIENT_HEX,
        NoNewPrivs: "1",
      });
      for (const name of ["uid-only", "uid-gid"]) {
        const record = records.find((candidate) => candidate.name === name);
        expect(record).toMatchObject({
          phase: "close",
          code: 0,
          signal: null,
        });
        expect(record?.stdout).toContain(`uid=${serviceIdentity.uid}(wechat-clawbot)`);
        expect(record?.stdout).toContain(`gid=${serviceIdentity.gid}(wechat-clawbot)`);
      }
      expect(records.find((record) => record.name === "codex-version")).toMatchObject({
        phase: "close",
        code: 0,
        signal: null,
      });
      expect(records.find((record) => record.name === "codex-version")?.stdout).toMatch(/^codex-cli \d/);
    },
  );

  it.runIf(process.getuid?.() === 0 && process.env.WECHAT_CLAWBOT_VERIFY_LIVE_OPS === "1")(
    "verifies the installed ops process has the exact effective capability set",
    async () => {
      const mainPid = await runCommand([
        "/usr/bin/systemctl", "show", "wechat-clawbot-ops.service",
        "--property=MainPID", "--value",
      ]);
      expect(mainPid).toMatchObject({ code: 0, signal: null });
      const pid = Number.parseInt(mainPid.stdout.trim(), 10);
      expect(pid).toBeGreaterThan(1);
      expect(statusFields(await readFile(`/proc/${pid}/status`, "utf8"))).toMatchObject({
        CapInh: EXPECTED_AMBIENT_HEX,
        CapPrm: EXPECTED_CAPABILITY_HEX,
        CapEff: EXPECTED_CAPABILITY_HEX,
        CapBnd: EXPECTED_CAPABILITY_HEX,
        CapAmb: EXPECTED_AMBIENT_HEX,
        NoNewPrivs: "1",
      });
    },
  );
});
