import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

export const MAX_WORK_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 2_000;

const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_EXTRACTED_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_DLP_BYTES = 2 * 1024 * 1024;

const MACRO_EXTENSIONS = new Set([".docm", ".xlsm", ".pptm"]);
const ZIP_EXTENSIONS = new Set([".zip", ".docx", ".xlsx", ".pptx", ...MACRO_EXTENSIONS]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".xml", ".log"]);
const ALLOWED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic", ".heif",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".rtf",
  ...MACRO_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  ".zip", ".7z", ".tar", ".gz",
  ".mp3", ".m4a", ".wav", ".ogg", ".mp4", ".mov", ".webm",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".gif": "image/gif", ".bmp": "image/bmp", ".heic": "image/heic", ".heif": "image/heif",
  ".pdf": "application/pdf", ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docm": "application/vnd.ms-word.document.macroEnabled.12", ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12", ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12", ".rtf": "application/rtf",
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ".yaml": "application/yaml", ".yml": "application/yaml", ".xml": "application/xml", ".log": "text/plain",
  ".zip": "application/zip", ".7z": "application/x-7z-compressed", ".tar": "application/x-tar",
  ".gz": "application/gzip", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
};

const SENSITIVE_NAME = /(?:^|[._-])(?:\.env|credentials?|secrets?|oauth|tokens?|id_rsa|id_ed25519|private[-_.]?key)(?:[._-]|$)|\.(?:pem|p12|pfx|key)$/i;
const SENSITIVE_CONTENT = /-----BEGIN [A-Z ]+PRIVATE KEY-----|\bAKID[A-Za-z0-9]{32}\b|\bsk-[A-Za-z0-9_-]{20,}\b|(?:secret[_ -]?key|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i;
const EXECUTABLE_EXT = /\.(?:exe|dll|com|msi|apk|dmg|pkg|appimage|iso|bat|cmd|ps1|vbs|scr)$/i;

export class WorkFileError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkFileError";
  }
}

export interface WorkFilePolicy {
  allowedRoots: readonly string[];
  maxBytes?: number;
  allowQuarantined?: boolean;
}

export interface InspectedWorkFile {
  inputPath: string;
  realPath: string;
  name: string;
  safeName: string;
  extension: string;
  mime: string;
  size: number;
  sha256: string;
  quarantined: boolean;
  archiveEntries?: number;
  archiveUncompressedBytes?: number;
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface ZipIndex {
  entries: ZipEntry[];
  byName: Map<string, ZipEntry>;
  totalUncompressed: number;
}

function safeName(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f/\\]/g, "_").replace(/\s+/g, " ").trim();
  const bounded = Buffer.from(normalized || "attachment").subarray(0, 180).toString("utf8").replace(/\uFFFD+$/g, "");
  return bounded || "attachment";
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function startsWith(buffer: Buffer, bytes: readonly number[], offset = 0): boolean {
  return bytes.every((value, index) => buffer[offset + index] === value);
}

function isFtyp(head: Buffer, brands?: readonly string[]): boolean {
  if (head.length < 12 || head.toString("ascii", 4, 8) !== "ftyp") return false;
  if (!brands) return true;
  const brandText = head.toString("ascii", 8, Math.min(head.length, 40));
  return brands.some((brand) => brandText.includes(brand));
}

function decodeText(buffer: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new WorkFileError("INVALID_TEXT", `${label} is not valid UTF-8 text`);
  }
}

function assertNoSensitiveContent(text: string): void {
  if (SENSITIVE_CONTENT.test(text)) {
    throw new WorkFileError("SENSITIVE_CONTENT", "file appears to contain credentials or private key material");
  }
}

async function readHead(filePath: string, length = 1024): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function assertSignature(extension: string, head: Buffer): void {
  const zip = startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06]);
  const ole = startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  let valid = false;
  switch (extension) {
    case ".jpg": case ".jpeg": valid = startsWith(head, [0xff, 0xd8, 0xff]); break;
    case ".png": valid = startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); break;
    case ".gif": valid = head.toString("ascii", 0, 6) === "GIF87a" || head.toString("ascii", 0, 6) === "GIF89a"; break;
    case ".webp": valid = head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP"; break;
    case ".bmp": valid = head.toString("ascii", 0, 2) === "BM"; break;
    case ".heic": case ".heif": valid = isFtyp(head, ["heic", "heix", "hevc", "hevx", "mif1", "msf1"]); break;
    case ".pdf": valid = head.toString("ascii", 0, 5) === "%PDF-"; break;
    case ".doc": case ".xls": case ".ppt": valid = ole; break;
    case ".docx": case ".xlsx": case ".pptx": case ".docm": case ".xlsm": case ".pptm": case ".zip": valid = zip; break;
    case ".7z": valid = startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]); break;
    case ".gz": valid = startsWith(head, [0x1f, 0x8b]); break;
    case ".tar": valid = head.length >= 265 && head.toString("ascii", 257, 262) === "ustar"; break;
    case ".mp3": valid = head.toString("ascii", 0, 3) === "ID3" || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0); break;
    case ".wav": valid = head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WAVE"; break;
    case ".ogg": valid = head.toString("ascii", 0, 4) === "OggS"; break;
    case ".m4a": valid = isFtyp(head); break;
    case ".mp4": case ".mov": valid = isFtyp(head); break;
    case ".webm": valid = startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]); break;
    case ".rtf": valid = head.toString("ascii", 0, 5) === "{\\rtf"; break;
    default: valid = TEXT_EXTENSIONS.has(extension); break;
  }
  if (!valid) throw new WorkFileError("TYPE_MISMATCH", "file extension does not match its content signature");
  if (startsWith(head, [0x4d, 0x5a]) || startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) {
    throw new WorkFileError("EXECUTABLE_BLOCKED", "executable files are not allowed");
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function readZipIndex(filePath: string): Promise<ZipIndex> {
  const info = await stat(filePath);
  const tailSize = Math.min(info.size, 65_557);
  const handle = await open(filePath, "r");
  try {
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, info.size - tailSize);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
    }
    if (eocd < 0) throw new WorkFileError("INVALID_ZIP", "ZIP central directory was not found");
    const disk = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    const entries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0 || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new WorkFileError("UNSUPPORTED_ZIP", "multi-disk and ZIP64 archives are not accepted");
    }
    if (entries > MAX_ARCHIVE_ENTRIES || centralSize > MAX_CENTRAL_DIRECTORY_BYTES || centralOffset + centralSize > info.size) {
      throw new WorkFileError("ARCHIVE_BUDGET", "archive exceeds entry or central-directory limits");
    }
    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);
    const index: ZipEntry[] = [];
    let cursor = 0;
    let totalUncompressed = 0;
    for (let i = 0; i < entries; i++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) {
        throw new WorkFileError("INVALID_ZIP", "invalid ZIP central-directory entry");
      }
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localHeaderOffset = central.readUInt32LE(cursor + 42);
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > central.length || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new WorkFileError("UNSUPPORTED_ZIP", "ZIP64 or truncated entries are not accepted");
      }
      const nameBuffer = central.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = (flags & 0x800) !== 0 ? decodeText(nameBuffer, "ZIP entry name") : nameBuffer.toString("latin1");
      const normalized = name.replaceAll("\\", "/");
      if (!normalized || normalized.includes("\u0000") || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
        throw new WorkFileError("ARCHIVE_PATH", "archive contains an unsafe entry path");
      }
      if ((flags & 1) !== 0) throw new WorkFileError("ENCRYPTED_ARCHIVE", "encrypted ZIP entries are not accepted");
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES || (compressedSize > 0 && uncompressedSize / compressedSize > 100)) {
        throw new WorkFileError("ARCHIVE_BOMB", "archive expansion ratio exceeds the safety budget");
      }
      index.push({ name: normalized, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
      cursor = end;
    }
    return { entries: index, byName: new Map(index.map((entry) => [entry.name, entry])), totalUncompressed };
  } finally {
    await handle.close();
  }
}

async function readZipEntry(filePath: string, entry: ZipEntry, maxBytes = MAX_EXTRACTED_ENTRY_BYTES): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes) throw new WorkFileError("ENTRY_TOO_LARGE", "archive entry exceeds extraction limit");
  if (entry.method !== 0 && entry.method !== 8) throw new WorkFileError("UNSUPPORTED_COMPRESSION", "archive entry uses unsupported compression");
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, header.length, entry.localHeaderOffset);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new WorkFileError("INVALID_ZIP", "invalid ZIP local header");
    const dataOffset = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const compressed = Buffer.alloc(entry.compressedSize);
    await handle.read(compressed, 0, compressed.length, dataOffset);
    const output = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: maxBytes });
    if (output.length !== entry.uncompressedSize) throw new WorkFileError("INVALID_ZIP", "archive entry size verification failed");
    return output;
  } finally {
    await handle.close();
  }
}

function xmlText(xml: string): string {
  const structured = xml
    .replace(/<\/(?:w:p|a:p|row|si|sst|worksheet|sheetData)>/gi, "\n")
    .replace(/<(?:w:tab|tab)\b[^>]*\/?>/gi, "\t")
    .replace(/<[^>]+>/g, " ");
  return structured
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, value: string) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

async function scanZipContents(filePath: string, extension: string, index: ZipIndex): Promise<void> {
  const names = new Set(index.entries.map((entry) => entry.name));
  const required = extension === ".docx" || extension === ".docm" ? "word/document.xml"
    : extension === ".xlsx" || extension === ".xlsm" ? "xl/workbook.xml"
      : extension === ".pptx" || extension === ".pptm" ? "ppt/presentation.xml" : undefined;
  if (required && (!names.has("[Content_Types].xml") || !names.has(required))) {
    throw new WorkFileError("TYPE_MISMATCH", "Office extension does not match the OOXML package structure");
  }
  const macro = index.entries.some((entry) => /(?:^|\/)vbaProject\.bin$/i.test(entry.name));
  if (macro && !MACRO_EXTENSIONS.has(extension)) {
    throw new WorkFileError("MACRO_MISMATCH", "macro content must use a macro-enabled Office extension");
  }
  for (const entry of index.entries) {
    if (SENSITIVE_NAME.test(path.posix.basename(entry.name))) {
      throw new WorkFileError("SENSITIVE_ARCHIVE", "archive contains a credential-like filename");
    }
  }
  let scanned = 0;
  for (const entry of index.entries) {
    if (scanned >= MAX_DLP_BYTES || entry.uncompressedSize === 0 || entry.uncompressedSize > 512 * 1024) continue;
    if (!/\.(?:txt|md|csv|json|ya?ml|xml|rels)$/i.test(entry.name)) continue;
    const buffer = await readZipEntry(filePath, entry, Math.min(512 * 1024, MAX_DLP_BYTES - scanned));
    scanned += buffer.length;
    assertNoSensitiveContent(decodeText(buffer, "archive text entry"));
  }
}

export async function inspectWorkFile(inputPath: string, policy: WorkFilePolicy): Promise<InspectedWorkFile> {
  if (inputPath.includes("\u0000")) throw new WorkFileError("INVALID_PATH", "file path contains NUL");
  const resolvedInput = inputPath.startsWith("file://") ? decodeURIComponent(new URL(inputPath).pathname) : inputPath;
  if (!path.isAbsolute(resolvedInput)) throw new WorkFileError("INVALID_PATH", "file path must be absolute");
  const linkInfo = await lstat(resolvedInput).catch(() => null);
  if (!linkInfo?.isFile() || linkInfo.isSymbolicLink()) throw new WorkFileError("INVALID_FILE", "path must be a regular non-symlink file");
  const canonical = await realpath(resolvedInput);
  const allowedRoots = await Promise.all(policy.allowedRoots.map(async (root) => await realpath(root).catch(() => path.resolve(root))));
  if (!allowedRoots.some((root) => isWithin(root, canonical))) throw new WorkFileError("PATH_OUTSIDE_ROOTS", "file is outside the managed media roots");
  const info = await stat(canonical);
  if (!info.isFile() || info.nlink !== 1) throw new WorkFileError("LINK_BLOCKED", "hard-linked and non-regular files are not accepted");
  const maxBytes = policy.maxBytes ?? MAX_WORK_FILE_BYTES;
  if (info.size <= 0 || info.size > maxBytes) throw new WorkFileError("FILE_SIZE", `file must be between 1 byte and ${maxBytes} bytes`);
  const name = path.basename(canonical);
  if (SENSITIVE_NAME.test(name) || EXECUTABLE_EXT.test(name)) throw new WorkFileError("SENSITIVE_NAME", "file type or filename is blocked");
  const extension = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new WorkFileError("UNSUPPORTED_TYPE", "file extension is not in the safe work-file allowlist");
  const quarantined = MACRO_EXTENSIONS.has(extension);
  if (quarantined && !policy.allowQuarantined) throw new WorkFileError("QUARANTINED", "macro-enabled Office files require explicit quarantine handling");
  const head = await readHead(canonical, extension === ".tar" ? 512 : 1024);
  assertSignature(extension, head);
  let archive: ZipIndex | undefined;
  if (ZIP_EXTENSIONS.has(extension)) {
    archive = await readZipIndex(canonical);
    await scanZipContents(canonical, extension, archive);
  } else if (TEXT_EXTENSIONS.has(extension) || extension === ".rtf") {
    const content = await readFile(canonical);
    assertNoSensitiveContent(decodeText(content.subarray(0, MAX_DLP_BYTES), "text file"));
  }
  return {
    inputPath,
    realPath: canonical,
    name,
    safeName: safeName(name),
    extension,
    mime: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
    size: info.size,
    sha256: await hashFile(canonical),
    quarantined,
    ...(archive ? { archiveEntries: archive.entries.length, archiveUncompressedBytes: archive.totalUncompressed } : {}),
  };
}

export interface ImportGeneratedImageOptions {
  generatedRoot: string;
  destinationRoot: string;
  name?: string;
}

export interface ImportedGeneratedImage {
  path: string;
  file: InspectedWorkFile;
  reused: boolean;
}

function importFileName(requested: string | undefined, source: InspectedWorkFile): string {
  if (requested === undefined) return source.safeName;
  const normalized = requested.normalize("NFKC").trim();
  if (
    normalized.length === 0
    || normalized.length > 180
    || normalized.includes("\u0000")
    || path.basename(normalized) !== normalized
    || /[/\\\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new WorkFileError("INVALID_NAME", "destination name must be a plain safe filename");
  }
  const requestedExtension = path.extname(normalized).toLowerCase();
  if (requestedExtension && requestedExtension !== source.extension) {
    throw new WorkFileError("TYPE_MISMATCH", "destination extension must match the generated image");
  }
  return requestedExtension ? normalized : `${normalized}${source.extension}`;
}

export async function importGeneratedImage(
  inputPath: string,
  options: ImportGeneratedImageOptions,
): Promise<ImportedGeneratedImage> {
  const source = await inspectWorkFile(inputPath, {
    allowedRoots: [options.generatedRoot],
    maxBytes: 20 * 1024 * 1024,
  });
  if (!source.mime.startsWith("image/")) {
    throw new WorkFileError("IMAGE_REQUIRED", "only generated image files can be imported");
  }

  await mkdir(options.destinationRoot, { recursive: true, mode: 0o750 });
  const destinationRoot = await realpath(options.destinationRoot);
  const destinationName = `${source.sha256.slice(0, 12)}-${importFileName(options.name, source)}`;
  const destinationPath = path.join(destinationRoot, destinationName);
  if (!isWithin(destinationRoot, destinationPath)) {
    throw new WorkFileError("PATH_OUTSIDE_ROOTS", "destination escaped the managed workspace");
  }

  let sourceHandle;
  let destinationHandle;
  let created = false;
  try {
    sourceHandle = await open(source.realPath, "r");
    const sourceInfo = await sourceHandle.stat();
    if (!sourceInfo.isFile() || sourceInfo.nlink !== 1 || sourceInfo.size !== source.size) {
      throw new WorkFileError("SOURCE_CHANGED", "generated image changed before import");
    }
    try {
      destinationHandle = await open(destinationPath, "wx", 0o640);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await inspectWorkFile(destinationPath, {
        allowedRoots: [destinationRoot],
        maxBytes: 20 * 1024 * 1024,
      });
      if (existing.sha256 !== source.sha256 || existing.mime !== source.mime) {
        throw new WorkFileError("DESTINATION_CONFLICT", "existing imported image does not match the generated source");
      }
      return { path: existing.realPath, file: existing, reused: true };
    }

    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < source.size) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, source.size - position), position);
      if (bytesRead <= 0) throw new WorkFileError("SOURCE_CHANGED", "generated image ended during import");
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten <= 0) throw new WorkFileError("IMPORT_FAILED", "workspace image import made no progress");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destinationHandle.sync();
  } catch (error) {
    if (created) await rm(destinationPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }

  const imported = await inspectWorkFile(destinationPath, {
    allowedRoots: [destinationRoot],
    maxBytes: 20 * 1024 * 1024,
  });
  if (imported.sha256 !== source.sha256 || imported.size !== source.size || imported.mime !== source.mime) {
    await rm(destinationPath, { force: true });
    throw new WorkFileError("IMPORT_VERIFY_FAILED", "workspace image import failed integrity verification");
  }
  return { path: imported.realPath, file: imported, reused: false };
}

export interface ExtractWorkFileOptions {
  allowedRoots: readonly string[];
  sheet?: string;
  cellRange?: string;
  slides?: string;
  maxChars?: number;
}

function parseSlideSelection(value: string | undefined, available: number[]): number[] {
  if (!value) return available.slice(0, 50);
  const selected = new Set<number>();
  for (const token of value.split(",")) {
    const match = token.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new WorkFileError("INVALID_SELECTOR", "slides must look like 1-5 or 1,3,7-9");
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end - start > 100) throw new WorkFileError("INVALID_SELECTOR", "slide selection is outside limits");
    for (let current = start; current <= end; current++) selected.add(current);
  }
  return available.filter((value) => selected.has(value)).slice(0, 50);
}

function columnNumber(label: string): number {
  let result = 0;
  for (const char of label.toUpperCase()) result = result * 26 + char.charCodeAt(0) - 64;
  return result;
}

function parseCellRange(value?: string): { minCol: number; minRow: number; maxCol: number; maxRow: number } | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^([A-Za-z]{1,3})(\d+):([A-Za-z]{1,3})(\d+)$/);
  if (!match) throw new WorkFileError("INVALID_SELECTOR", "cellRange must look like A1:D50");
  const minCol = columnNumber(match[1]!); const minRow = Number(match[2]);
  const maxCol = columnNumber(match[3]!); const maxRow = Number(match[4]);
  if (minCol > maxCol || minRow > maxRow || (maxCol - minCol + 1) * (maxRow - minRow + 1) > 10_000) {
    throw new WorkFileError("INVALID_SELECTOR", "cellRange exceeds the 10,000-cell extraction limit");
  }
  return { minCol, minRow, maxCol, maxRow };
}

function attribute(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"));
  return match?.[1];
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function extractXlsx(filePath: string, index: ZipIndex, options: ExtractWorkFileOptions): Promise<string> {
  const sharedEntry = index.byName.get("xl/sharedStrings.xml");
  const shared = sharedEntry ? decodeText(await readZipEntry(filePath, sharedEntry, 20 * 1024 * 1024), "shared strings") : "";
  const sharedStrings = [...shared.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => xmlText(match[1] ?? ""));
  const workbookEntry = index.byName.get("xl/workbook.xml");
  const relsEntry = index.byName.get("xl/_rels/workbook.xml.rels");
  if (!workbookEntry || !relsEntry) throw new WorkFileError("INVALID_XLSX", "workbook metadata is incomplete");
  const workbook = decodeText(await readZipEntry(filePath, workbookEntry), "workbook");
  const rels = decodeText(await readZipEntry(filePath, relsEntry), "workbook relationships");
  const relations = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b([^>]+)\/?\s*>/gi)) {
    const id = attribute(match[1] ?? "", "Id"); const target = attribute(match[1] ?? "", "Target");
    if (id && target) relations.set(id, path.posix.normalize(target.startsWith("/") ? target.slice(1) : `xl/${target}`));
  }
  const sheets: Array<{ name: string; file: string }> = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]+)\/?\s*>/gi)) {
    const attrs = match[1] ?? "";
    const name = attribute(attrs, "name"); const relation = attribute(attrs, "r:id");
    const file = relation ? relations.get(relation) : undefined;
    if (name && file) sheets.push({ name: decodeXmlAttribute(name), file });
  }
  const selected = options.sheet ? sheets.filter((sheet) => sheet.name === options.sheet) : sheets.slice(0, 5);
  if (selected.length === 0) throw new WorkFileError("SHEET_NOT_FOUND", "requested worksheet was not found");
  const range = parseCellRange(options.cellRange);
  const output: string[] = [];
  for (const sheet of selected) {
    const entry = index.byName.get(sheet.file);
    if (!entry) continue;
    const xml = decodeText(await readZipEntry(filePath, entry), `worksheet ${sheet.name}`);
    output.push(`# 工作表：${sheet.name}`);
    let count = 0;
    for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attrs = match[1] ?? ""; const body = match[2] ?? "";
      const ref = attribute(attrs, "r");
      const refMatch = ref?.match(/^([A-Za-z]+)(\d+)$/);
      if (!ref || !refMatch) continue;
      const col = columnNumber(refMatch[1]!); const row = Number(refMatch[2]);
      if (range && (col < range.minCol || col > range.maxCol || row < range.minRow || row > range.maxRow)) continue;
      const type = attribute(attrs, "t");
      const raw = body.match(/<v>([\s\S]*?)<\/v>/i)?.[1] ?? body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/i)?.[1] ?? "";
      const value = type === "s" ? sharedStrings[Number(raw)] ?? "" : xmlText(raw);
      output.push(`${ref}\t${value}`);
      if (++count >= 10_000) break;
    }
  }
  return output.join("\n");
}

export async function extractWorkFile(inputPath: string, options: ExtractWorkFileOptions): Promise<{ text: string; file: InspectedWorkFile }> {
  const file = await inspectWorkFile(inputPath, { allowedRoots: options.allowedRoots, maxBytes: MAX_WORK_FILE_BYTES });
  const maxChars = Math.max(1_000, Math.min(options.maxChars ?? 100_000, 200_000));
  let text: string;
  if (TEXT_EXTENSIONS.has(file.extension) || file.extension === ".rtf") {
    text = decodeText(await readFile(file.realPath), "work file");
  } else if (file.extension === ".docx") {
    const index = await readZipIndex(file.realPath);
    const names = ["word/document.xml", ...index.entries.map((entry) => entry.name).filter((name) => /^word\/(?:header|footer)\d+\.xml$/i.test(name))];
    const parts: string[] = [];
    for (const name of names) {
      const entry = index.byName.get(name);
      if (entry) parts.push(xmlText(decodeText(await readZipEntry(file.realPath, entry), name)));
    }
    text = parts.join("\n\n");
  } else if (file.extension === ".pptx") {
    const index = await readZipIndex(file.realPath);
    const available = index.entries.map((entry) => entry.name.match(/^ppt\/slides\/slide(\d+)\.xml$/i)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
    const selected = parseSlideSelection(options.slides, available);
    const parts: string[] = [];
    for (const slide of selected) {
      const entry = index.byName.get(`ppt/slides/slide${slide}.xml`);
      if (entry) parts.push(`# 第 ${slide} 页\n${xmlText(decodeText(await readZipEntry(file.realPath, entry), `slide ${slide}`))}`);
    }
    text = parts.join("\n\n");
  } else if (file.extension === ".xlsx") {
    text = await extractXlsx(file.realPath, await readZipIndex(file.realPath), options);
  } else if (file.extension === ".pdf") {
    throw new WorkFileError("USE_PDF_TOOL", "use the built-in pdf tool for PDF analysis");
  } else {
    throw new WorkFileError("TRANSPORT_ONLY", "this legacy or media format is supported for transport but not text extraction");
  }
  const bounded = text.length > maxChars ? `${text.slice(0, maxChars)}\n[内容已截断]` : text;
  return { text: bounded || "[文件中没有可提取的文本]", file };
}
