import { mkdir, open, rename, stat } from "node:fs/promises";
import path from "node:path";
import { redactObject } from "./security.js";

export class AuditLog {
  readonly filePath: string;
  readonly maxBytes: number;

  constructor(dataDir: string, maxBytes = 25 * 1024 * 1024) {
    this.filePath = path.join(dataDir, "logs", "ops-audit.jsonl");
    this.maxBytes = maxBytes;
  }

  async append(event: Record<string, unknown>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o750 });
    const current = await stat(this.filePath).catch(() => null);
    if (current && current.size >= this.maxBytes) {
      await rename(this.filePath, `${this.filePath}.${Date.now()}`);
    }
    const line = `${JSON.stringify(redactObject({ timestamp: new Date().toISOString(), ...event }))}\n`;
    const handle = await open(this.filePath, "a", 0o640);
    try {
      await handle.write(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
