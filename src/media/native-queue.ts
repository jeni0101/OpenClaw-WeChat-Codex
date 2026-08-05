export const NATIVE_RETRYABLE_ERRORS = new Set([
  "WEIXIN_PRESIGN_FAILED",
  "WEIXIN_UPLOAD_URL_MISSING",
  "WEIXIN_CDN_5XX",
  "WEIXIN_CDN_PROTOCOL",
  "WEIXIN_CDN_NETWORK",
  "WEIXIN_CDN_TIMEOUT",
  "WEIXIN_SEND_FAILED",
]);
// Tencent's current throttling window is not a fixed "large file" limit:
// production has returned the same empty-body 500 for 914 KiB, 1.56 MiB and
// 1.91 MiB tasks. Treat 512 KiB and above as account-circuit traffic so those
// retries cannot consume the recovery window reserved for queued large files.
export const NATIVE_LARGE_THRESHOLD_BYTES = 512 * 1024;
// A failure near the 50 MiB safety ceiling must not impose its multi-hour
// cooldown on ordinary 4–32 MiB attachments that have separate production
// evidence. Lower-tier failures remain account-wide and therefore still block
// the boundary tier.
export const NATIVE_BOUNDARY_THRESHOLD_BYTES = 40 * 1024 * 1024;
export const NATIVE_MESSAGE_RETRY_DELAY_MS = 15 * 60_000;
// Per-delivery backoff can grow to several hours, but an old delivery must not
// turn that private schedule into an account-wide queue outage.
export const NATIVE_FAILURE_COOLDOWN_MS = 15 * 60_000;
export const NATIVE_SUCCESS_COOLDOWN_MS = 15 * 60_000;

const SMALL_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
] as const;

const LARGE_RETRY_DELAYS_MS = [
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  120 * 60_000,
  240 * 60_000,
  480 * 60_000,
] as const;

const BOUNDARY_RETRY_DELAYS_MS = [
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  60 * 60_000,
  60 * 60_000,
  60 * 60_000,
] as const;

export function nativeQueueRetryDelays(size: number): readonly number[] {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid native queue file size");
  if (size >= NATIVE_BOUNDARY_THRESHOLD_BYTES) return BOUNDARY_RETRY_DELAYS_MS;
  return size >= NATIVE_LARGE_THRESHOLD_BYTES ? LARGE_RETRY_DELAYS_MS : SMALL_RETRY_DELAYS_MS;
}

export function nativeQueueInitialAttemptAt(
  size: number,
  now: number,
  largeCircuitUntil: number,
  boundaryCircuitUntil = 0,
): number {
  if (![size, now, largeCircuitUntil, boundaryCircuitUntil].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  )) {
    throw new Error("invalid native queue scheduling input");
  }
  if (size >= NATIVE_BOUNDARY_THRESHOLD_BYTES) {
    return Math.max(now, largeCircuitUntil, boundaryCircuitUntil);
  }
  return size >= NATIVE_LARGE_THRESHOLD_BYTES ? Math.max(now, largeCircuitUntil) : now;
}

export function nativeQueueCircuitBlocks(
  size: number,
  now: number,
  largeCircuitUntil: number,
  boundaryCircuitUntil = 0,
): boolean {
  return nativeQueueInitialAttemptAt(
    size,
    now,
    largeCircuitUntil,
    boundaryCircuitUntil,
  ) > now;
}

export function nativeQueueNextDelay(
  size: number,
  completedAttempts: number,
  errorCode: string,
): number | undefined {
  if (!Number.isSafeInteger(completedAttempts) || completedAttempts < 1) {
    throw new Error("invalid completed attempt count");
  }
  if (!NATIVE_RETRYABLE_ERRORS.has(errorCode)) return undefined;
  if (errorCode === "WEIXIN_SEND_FAILED") {
    return completedAttempts <= 6 ? NATIVE_MESSAGE_RETRY_DELAY_MS : undefined;
  }
  return nativeQueueRetryDelays(size)[completedAttempts - 1];
}

export function nativeQueueFailureCircuitUntil(completedAt: number): number {
  if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
    throw new Error("invalid native queue failure completion time");
  }
  return completedAt + NATIVE_FAILURE_COOLDOWN_MS;
}

export function nativeQueueOpensCircuit(errorCode: string): boolean {
  return NATIVE_RETRYABLE_ERRORS.has(errorCode) && errorCode !== "WEIXIN_SEND_FAILED";
}

export function nativeQueueOpensMessageCircuit(errorCode: string): boolean {
  return errorCode === "WEIXIN_SEND_FAILED";
}

export function nativeQueueMessageRefreshBlocks(requiredAfterContextMtimeMs: number): boolean {
  if (!Number.isSafeInteger(requiredAfterContextMtimeMs) || requiredAfterContextMtimeMs < 0) {
    throw new Error("invalid message context refresh requirement");
  }
  return requiredAfterContextMtimeMs > 0;
}

export function nativeQueueContextRefreshSatisfied(
  requiredAfterContextMtimeMs: number,
  currentContextMtimeMs: number,
): boolean {
  if (!Number.isSafeInteger(currentContextMtimeMs) || currentContextMtimeMs < 0) {
    throw new Error("invalid current context mtime");
  }
  return nativeQueueMessageRefreshBlocks(requiredAfterContextMtimeMs)
    && currentContextMtimeMs > requiredAfterContextMtimeMs;
}
