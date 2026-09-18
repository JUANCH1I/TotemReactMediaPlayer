import { resolveMediaRecovery } from './mediaRecoveryPolicy'

// How a live screen recovers, and when it stops trying.
//
// A broadcast drops for many reasons that fix themselves within minutes, so a
// live screen keeps reconnecting with the same backoff a single-item playlist
// uses. A broadcast that has been dead for a long stretch is a different
// matter: nobody is coming back to it tonight, and a black screen in a dining
// room is worse than the playlist, so the totem hands itself back.

export const LIVE_GIVE_UP_MS = 10 * 60 * 1000
// Wall-clock time in the "playing" state after which a stream counts as
// healthy. Playback state is the only evidence used: expo-video's reported
// position does not advance reliably for live HLS on the totems, while the
// player's playing/buffering state does track the broadcast.
export const LIVE_HEALTHY_PLAYING_MS = 5000
// A stream must reach "playing" within this after being opened.
export const LIVE_STARTUP_GRACE_MS = 20000
// Once it has played, this long without playing (buffering or paused) is a
// stall. A frozen encoder ends up here too: ExoPlayer drains its window and
// reports buffering.
export const LIVE_STALL_MS = 12000

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

// A stream that stops playing is as broken as one that errors, but the
// native player only reports the latter. This watchdog watches the player's
// playing state alone: it never looks at the reported position, which does
// not advance reliably for live HLS. `start` opens a session and `stop`
// closes it, so a timer from a previous attempt cannot fire into the next.
export function createLiveStallWatchdog({
  onStall,
  schedule = setTimeout,
  cancel = clearTimeout,
  startupGraceMs = LIVE_STARTUP_GRACE_MS,
  stallMs = LIVE_STALL_MS,
}) {
  let session = 0
  let active = false
  let hasPlayed = false
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
      hasPlayed = false
      arm(startupGraceMs)
    },
    // The player's playing state, as it changes. Playing disarms the timer;
    // not playing arms the stall (or, before the first frame, leaves the
    // startup grace running rather than extending it).
    setPlaying(isPlaying) {
      if (!active) return

      if (isPlaying) {
        hasPlayed = true
        clearTimer()
      } else if (hasPlayed) {
        arm(stallMs)
      }
    },
    stop() {
      active = false
      clearTimer()
    },
  }
}
