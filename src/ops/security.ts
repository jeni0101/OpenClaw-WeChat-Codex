import { createHash, timingSafeEqual } from "node:crypto";
import { BrokerError } from "./errors.js";

const SENSITIVE_KEY = /(?:authorization|cookie|oauth|token|secret|password|passwd|credential|private.?key|api.?key|chat.?text|prompt|message.?body|request.?body|env)/i;
const SENSITIVE_VALUE = /(?:bearer\s+[a-z0-9._~+/=-]{12,}|sk-[a-z0-9_-]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/gi;
const SENSITIVE_ASSIGNMENT = /\b(?:authorization|cookie|oauth|token|secret|password|passwd|credential|private.?key|api.?key)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const ENVIRONMENT_LINE = /(^|\n)[ \t]*(?:export[ \t]+)?[A-Z_][A-Z0-9_]*=[^\r\n]*/g;
const IDENTITY_VALUE = /\b(?:wxid_[a-z0-9._-]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|[a-z0-9._-]+@im\.wechat)\b/gi;
const HOME_PATH = /\/(?:home\/[^/\s]+|root)(?=\/|\s|$)/g;
const OUTPUT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function requestSummary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) throw new BrokerError("INVALID_REQUEST", "request must not be empty");
  if (CONTROL.test(normalized)) throw new BrokerError("INVALID_REQUEST", "request contains control characters");
  if (Buffer.byteLength(normalized) > 4096) {
    throw new BrokerError("INVALID_REQUEST", "request exceeds 4096 bytes");
  }
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

export function assertSafeIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value)) {
    throw new BrokerError("INVALID_IDENTIFIER", `${label} is invalid`);
  }
  return value;
}

export function secretEquals(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function redactText(input: string, maxBytes = 32_768): string {
  const redacted = input.replace(SENSITIVE_VALUE, "[REDACTED]");
  const bytes = Buffer.from(redacted);
  if (bytes.length <= maxBytes) return redacted;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}\n[TRUNCATED]`;
}

export function redactDiagnosticText(input: string, request: string, maxBytes = 8_192): string {
  const withoutRequest = request ? input.replaceAll(request, "[REDACTED_REQUEST]") : input;
  const redacted = withoutRequest
    .replace(ENVIRONMENT_LINE, "$1[REDACTED_ENV]")
    .replace(SENSITIVE_VALUE, "[REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(IDENTITY_VALUE, "[REDACTED_IDENTITY]")
    .replace(HOME_PATH, "/[REDACTED_HOME]")
    .replace(OUTPUT_CONTROL, "\uFFFD");
  const bytes = Buffer.from(redacted);
  if (bytes.length <= maxBytes) return redacted;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}\n[TRUNCATED]`;
}

export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[MAX_DEPTH]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactText(value, 8_192);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactObject(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactObject(child, depth + 1);
    }
    return result;
  }
  return String(value);
}

export function assertOwner(actor: { senderId?: string; senderIsOwner?: boolean }, ownerId: string): void {
  if (!actor.senderIsOwner || !actor.senderId || actor.senderId !== ownerId) {
    throw new BrokerError("OWNER_REQUIRED", "only the bound WeChat owner may perform this operation", 403);
  }
}

export function isExcludedRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "")) return true;
  const base = parts.at(-1) ?? "";
  if (/^\.env(?:\.|$)/i.test(base)) return true;
  if (/(?:secret|credential|private[-_.]?key|id_rsa|id_ed25519)/i.test(base)) return true;
  return parts.some((part) => [
    ".git", "node_modules", ".venv", "venv", "__pycache__", "data", "backups", "cache", "tmp",
  ].includes(part));
}
