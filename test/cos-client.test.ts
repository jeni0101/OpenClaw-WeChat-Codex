import COS from "cos-nodejs-sdk-v5";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOWNLOAD_CHUNK_BYTES, downloadObject, type CosSettings } from "../src/cos/client.js";

const roots: string[] = [];
const settings: CosSettings = {
  bucket: "test-bucket-123",
  region: "ap-test",
  secretId: "test-id",
  secretKey: "test-key",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("COS ranged downloads", () => {
  it("downloads immutable chunks and writes the exact object bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-cos-download-"));
    roots.push(root);
    const target = path.join(root, "object.bin");
    const contents = Buffer.alloc(DOWNLOAD_CHUNK_BYTES + 17);
    contents.fill(0x41, 0, DOWNLOAD_CHUNK_BYTES);
    contents.fill(0x42, DOWNLOAD_CHUNK_BYTES);
    const getObject = vi.fn(async (params: COS.GetObjectParams): Promise<COS.GetObjectResult> => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(params.Range ?? "");
      if (!match) throw new Error("missing range");
      const start = Number(match[1]);
      const end = Number(match[2]);
      return { Body: contents.subarray(start, end + 1), ETag: '"test-etag"' } as COS.GetObjectResult;
    });
    const cos = {
      headObject: vi.fn(async () => ({
        ETag: '"test-etag"',
        headers: { "content-length": String(contents.length) },
      })),
      getObject,
    } as unknown as COS;

    await downloadObject(cos, settings, "backup/object.bin", target);

    expect(Buffer.compare(await readFile(target), contents)).toBe(0);
    expect(getObject).toHaveBeenCalledTimes(2);
    expect(getObject.mock.calls.map(([params]) => [params.Range, params.IfMatch])).toEqual([
      [`bytes=0-${DOWNLOAD_CHUNK_BYTES - 1}`, '"test-etag"'],
      [`bytes=${DOWNLOAD_CHUNK_BYTES}-${contents.length - 1}`, '"test-etag"'],
    ]);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("removes the partial destination when object metadata is invalid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-cos-download-"));
    roots.push(root);
    const target = path.join(root, "object.bin");
    const cos = {
      headObject: vi.fn(async () => ({ ETag: '"test-etag"', headers: {} })),
      getObject: vi.fn(),
    } as unknown as COS;

    await expect(downloadObject(cos, settings, "backup/object.bin", target))
      .rejects.toThrow("invalid object size");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites an existing destination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wechat-cos-download-"));
    roots.push(root);
    const target = path.join(root, "object.bin");
    await writeFile(target, "keep-me", { mode: 0o600 });
    const cos = { headObject: vi.fn(), getObject: vi.fn() } as unknown as COS;

    await expect(downloadObject(cos, settings, "backup/object.bin", target))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf8")).toBe("keep-me");
    expect(cos.headObject).not.toHaveBeenCalled();
  });
});
