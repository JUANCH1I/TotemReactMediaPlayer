// A playlist with a single item has nothing to advance to, so its only way out of
// a load failure is to retry itself. Retrying on a fixed timer would hammer the
// network forever on a permanently broken URL, so repeated failures back off.
export const MEDIA_ERROR_DISPLAY_MS = 2000
export const MEDIA_RETRY_MAX_DELAY_MS = 30000

export const MediaRecoveryAction = {
  ADVANCE: 'ADVANCE',
  RETRY: 'RETRY',
  NONE: 'NONE',
}

// Doubling past 2^31 only produces numbers the cap discards, and keeping the
// exponent finite protects the result from a runaway failure counter.
const MAX_BACKOFF_EXPONENT = 31

function resolveRetryDelay(failureCount, baseDelayMs, maxDelayMs) {
  // The first failure is indistinguishable from a transient one, so it retries
  // after the same delay the error screen is already shown for.
  const attempt =
    Number.isFinite(failureCount) && failureCount > 1 ? Math.floor(failureCount) : 1
  const exponent = Math.min(attempt - 1, MAX_BACKOFF_EXPONENT)
  return Math.min(baseDelayMs * 2 ** exponent, maxDelayMs)
}

export function resolveMediaRecovery({
  playlistLength,
  failureCount,
  baseDelayMs = MEDIA_ERROR_DISPLAY_MS,
  maxDelayMs = MEDIA_RETRY_MAX_DELAY_MS,
} = {}) {
  // An empty playlist shows the pairing screen instead; scheduling recovery there
  // would only keep a timer alive with no item to act on.
  if (!Number.isFinite(playlistLength) || playlistLength <= 0) {
    return { action: MediaRecoveryAction.NONE, delayMs: 0 }
  }

  if (playlistLength > 1) {
    return { action: MediaRecoveryAction.ADVANCE, delayMs: baseDelayMs }
  }

  return {
    action: MediaRecoveryAction.RETRY,
    delayMs: resolveRetryDelay(failureCount, baseDelayMs, maxDelayMs),
  }
}
