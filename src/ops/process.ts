import { spawn } from "node:child_process";
import { BrokerError } from "./errors.js";
import type { CommandResult } from "./types.js";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
  input?: string;
}

export async function runCommand(argv: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
  if (argv.length === 0 || !argv[0]?.startsWith("/")) {
    throw new BrokerError("INVALID_COMMAND", "commands must use an absolute executable path");
  }
  if (argv.some((arg) => arg.includes("\u0000"))) {
    throw new BrokerError("INVALID_COMMAND", "command argument contains NUL");
  }

  const started = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? {
        PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      uid: options.uid,
      gid: options.gid,
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") reject(error);
      });
      child.stdin.end(options.input);
    }

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.length >= maxOutputBytes) {
        truncated = true;
        return current;
      }
      const remaining = maxOutputBytes - current.length;
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };

    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timer.unref();
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        argv: [...argv],
        code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    });
  });
}
