import { resolveMediaRecovery } from './mediaRecoveryPolicy'

// How a live screen recovers, and when it stops trying.
//
// A broadcast drops for many reasons that fix themselves within minutes, so a
// live screen keeps reconnecting with the same backoff a single-item playlist
// uses. A broadcast that has been dead for a long stretch is a different
// matter: nobody is coming back to it tonight, and a black screen in a dining
// room is worse than the playlist, so the totem hands itself back.

export const LIVE_GIVE_UP_MS = 10 * 60 * 1000
// Progress the stream must make before it counts as healthy again. A stream
// that says "playing" but never advances is not healthy.
export const LIVE_HEALTHY_AFTER_SECONDS = 15

export const LiveRecoveryAction = {
  RETRY: 'RETRY',
  GIVE_UP: 'GIVE_UP',
}

// The failure streak is measured on a monotonic clock: a television whose
// wall clock jumps forward after an NTP sync must not look like it has been
// failing for hours.
export const monotonicNow = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

export function resolveLiveRecovery({
  failingSinceMs,
  attempt,
  now = monotonicNow,
  nowMs = now(),
  giveUpAfterMs = LIVE_GIVE_UP_MS,
}) {
  const failingForMs =
    Number.isFinite(failingSinceMs) && Number.isFinite(nowMs)
      ? nowMs - failingSinceMs
      : 0
  if (failingForMs >= giveUpAfterMs) {
    return { action: LiveRecoveryAction.GIVE_UP, delayMs: 0 }
  }

  return {
    action: LiveRecoveryAction.RETRY,
    // The single-item retry curve: 2 s doubling up to 30 s.
    delayMs: resolveMediaRecovery({ playlistLength: 1, failureCount: attempt })
      .delayMs,
  }
}

// A stream that stops advancing is as broken as one that errors, but the
// native player only reports the latter. This is the MediaPlayer watchdog
// reduced to one stream: no item generations, just a session that `start`
// opens and `stop` closes so a timer from a previous attempt cannot fire into
// the next one. It also reports when the stream has genuinely advanced for a
// while, which is the only evidence that a recovery worked.
export function createLiveStallWatchdog({
  onStall,
  onHealthy = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
  startupGraceMs = 20000,
  stallThresholdMs = 12000,
  minimumProgressSeconds = 0.25,
  healthyAfterSeconds = LIVE_HEALTHY_AFTER_SECONDS,
}) {
  let session = 0
  let active = false
  let lastPlaybackTime = null
  let progressSeconds = 0
  let healthyReported = false
  let timeout = null

  const clearTimer = () => {
    if (timeout === null) return
    cancel(timeout)
    timeout = null
  }

  const arm = (delay) => {
    if (!active) return

    const armedSession = session
    clearTimer()
    timeout = schedule(() => {
      timeout = null
      if (!active || armedSession !== session) return

      active = false
      onStall()
    }, delay)
  }

  return {
    start() {
      clearTimer()
      session += 1
      active = true
      lastPlaybackTime = null
      progressSeconds = 0
      healthyReported = false
      arm(startupGraceMs)
    },
    allowGrace() {
      arm(startupGraceMs)
    },
    recordProgress(currentTime) {
      if (!active || !Number.isFinite(currentTime)) return

      // The first reading is where a live stream happens to start, not
      // progress; only movement from there counts.
      if (lastPlaybackTime === null) {
        lastPlaybackTime = currentTime
        return
      }

      const delta = Math.abs(currentTime - lastPlaybackTime)
      if (delta < minimumProgressSeconds) return

      lastPlaybackTime = currentTime
      progressSeconds += delta
      arm(stallThresholdMs)
      if (!healthyReported && progressSeconds >= healthyAfterSeconds) {
        healthyReported = true
        onHealthy()
      }
    },
    stop() {
      active = false
      clearTimer()
    },
  }
}
