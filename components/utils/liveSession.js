import {
  LIVE_GIVE_UP_MS,
  LIVE_HEALTHY_PLAYING_MS,
  LiveRecoveryAction,
  createLiveStallWatchdog,
  monotonicNow,
  resolveLiveRecovery,
} from './liveRecovery'

// How far behind the live edge a broadcast plays. ExoPlayer otherwise sits
// several segments back; 1.5 s absorbs the tunnel jitter and keeps the
// screens close to the operator (needs the expo-video patch in patches/).
export const LIVE_TARGET_OFFSET_SECONDS = 1.5

// The life of one live broadcast on a screen, kept out of React so it can be
// driven by a fake player and a fake clock.
//
// A session opens a URL, watches it, reopens it with backoff when it drops,
// and after a long enough streak of failures asks to give the screen back.
// The streak is continuous failure only: any healthy period resets it, so a
// broadcast that drops now and then is never given up on. It never asks while
// the totem itself is offline (that is the totem's outage, not the
// broadcast's), and it never leaves audio running after the dashboard clears
// the broadcast.

export const LivePhase = {
  // No frame yet since the stream was first opened.
  CONNECTING: 'CONNECTING',
  PLAYING: 'PLAYING',
  // Dropped at least once and not yet back; stays through the reopen.
  RETRYING: 'RETRYING',
  // Nothing configured.
  NONE: 'NONE',
}

// While the totem is offline, or after a give-up that could not be written,
// the decision is looked at again this often.
export const LIVE_DEFERRED_RECHECK_MS = 30000

export function createLiveSession({
  player,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = monotonicNow,
  isConnected = () => true,
  onGiveUp = () => {},
  onPhase = () => {},
  giveUpAfterMs = LIVE_GIVE_UP_MS,
  healthyPlayingMs = LIVE_HEALTHY_PLAYING_MS,
  watchdogOptions = {},
}) {
  let url = null
  let attempt = 0
  let failingSinceMs = null
  let attemptFailed = false
  let healthyThisAttempt = false
  let gaveUp = false
  let timer = null
  let healthyTimer = null
  let phase = null
  let subscriptions = []

  const setPhase = (next) => {
    if (phase === next) return
    phase = next
    onPhase(next)
  }

  const clearTimer = () => {
    if (timer === null) return
    cancel(timer)
    timer = null
  }

  const later = (callback, delayMs) => {
    clearTimer()
    timer = schedule(() => {
      timer = null
      callback()
    }, delayMs)
  }

  const clearHealthyTimer = () => {
    if (healthyTimer === null) return
    cancel(healthyTimer)
    healthyTimer = null
  }

  // A healthy period ends the failure streak: whatever happens next is a new
  // outage with its own ten minutes. Reported once per (re)open.
  const markHealthy = (evidence) => {
    if (healthyThisAttempt) return

    healthyThisAttempt = true
    console.info(
      `Live stream healthy (${evidence})` +
        (failingSinceMs === null ? '' : '; failure streak reset')
    )
    failingSinceMs = null
    attempt = 0
  }

  // Uninterrupted playback for the window is the evidence of health. The
  // reported position is deliberately not consulted: on the totems it stays
  // put for live HLS while the broadcast is visibly fine.
  const evaluatePlayingHealth = () => {
    healthyTimer = null
    markHealthy(`playing for ${healthyPlayingMs} ms`)
  }

  // The native player may already be released when the screen unmounts
  // (expo-video frees it on its own). Any access to a released shared
  // object throws, even reading a property, and an exception escaping an
  // effect cleanup or a timer takes the whole app down. Every player access
  // therefore goes through this guard.
  const withPlayer = (label, action, fallback = undefined) => {
    try {
      return action()
    } catch (error) {
      console.warn(`Live player ${label} skipped:`, error?.message || error)
      return fallback
    }
  }

  const silence = () => {
    withPlayer('pause', () => player.pause())
    // Unloading a player that holds nothing (idle, or errored before it
    // loaded) makes ExoPlayer open an empty source and log a playback error;
    // only a loaded or loading source needs releasing. An unknown status is
    // treated as loaded so audio can never be left running.
    const status = withPlayer('status read', () => player.status, 'released')
    if (status === 'idle' || status === 'error' || status === 'released') return
    withPlayer('release', () => player.replace(null))
  }

  const watchdog = createLiveStallWatchdog({
    onStall: () => fail('playback stalled'),
    schedule,
    cancel,
    ...watchdogOptions,
  })

  const open = () => {
    attemptFailed = false
    healthyThisAttempt = false
    clearHealthyTimer()
    watchdog.start()
    const opened = withPlayer(
      'open',
      () => {
        player.replace({ uri: url, contentType: 'hls', liveTargetOffset: LIVE_TARGET_OFFSET_SECONDS })
        return true
      },
      false
    )
    if (!opened) fail('player unavailable')
  }

  // Asks for the screen back, exactly once, and only when the totem can
  // actually reach the database. Offline, or if the write fails, the question
  // is asked again later; the stream keeps being retried meanwhile.
  const giveUpOrDefer = () => {
    if (gaveUp) return

    if (!isConnected()) {
      later(url === null ? giveUpOrDefer : open, LIVE_DEFERRED_RECHECK_MS)
      return
    }

    gaveUp = true
    watchdog.stop()
    let outcome
    try {
      outcome = onGiveUp()
    } catch (error) {
      outcome = Promise.reject(error)
    }
    if (outcome && typeof outcome.then === 'function') {
      outcome.then(undefined, () => {
        gaveUp = false
        later(url === null ? giveUpOrDefer : open, LIVE_DEFERRED_RECHECK_MS)
      })
    }
  }

  function fail(reason) {
    if (url === null || attemptFailed || gaveUp) return

    attemptFailed = true
    clearHealthyTimer()
    watchdog.stop()
    const nowMs = now()
    if (failingSinceMs === null) {
      failingSinceMs = nowMs
      console.info(`Live stream failure streak started: ${reason}`)
    }
    attempt += 1
    setPhase(LivePhase.RETRYING)

    const recovery = resolveLiveRecovery({
      failingSinceMs,
      nowMs,
      attempt,
      giveUpAfterMs,
    })
    if (recovery.action === LiveRecoveryAction.GIVE_UP) {
      giveUpOrDefer()
      return
    }

    later(open, recovery.delayMs)
  }

  const handlers = {
    handleStatus({ status, error }) {
      if (url === null || attemptFailed || gaveUp) return

      if (status === 'error') {
        fail(error?.message ?? 'player error')
      } else if (status === 'readyToPlay' && !withPlayer('playing read', () => player.playing, true)) {
        withPlayer('play', () => player.play())
      }
    },
    handlePlaying({ isPlaying }) {
      if (url === null || attemptFailed || gaveUp) return

      watchdog.setPlaying(isPlaying)
      if (isPlaying) {
        setPhase(LivePhase.PLAYING)
        // The window restarts after every pause or rebuffer: it must be one
        // uninterrupted stretch of playback.
        if (!healthyThisAttempt && healthyTimer === null) {
          healthyTimer = schedule(evaluatePlayingHealth, healthyPlayingMs)
        }
      } else {
        clearHealthyTimer()
      }
    },
    handleError(reason) {
      fail(reason)
    },
    // A live stream has no end; reaching one means the broadcast dropped.
    handleEnd() {
      fail('stream ended')
    },
  }

  const attach = () => {
    if (subscriptions.length > 0) return

    subscriptions = [
      player.addListener('statusChange', handlers.handleStatus),
      player.addListener('playingChange', handlers.handlePlaying),
      player.addListener('playToEnd', handlers.handleEnd),
    ]
  }

  const detach = () => {
    subscriptions.forEach((subscription) => subscription.remove())
    subscriptions = []
  }

  const reset = () => {
    clearTimer()
    clearHealthyTimer()
    watchdog.stop()
    attemptFailed = false
    healthyThisAttempt = false
    attempt = 0
    failingSinceMs = null
    gaveUp = false
  }

  return {
    ...handlers,
    // `null` means "nothing configured": the screen waits, silently, but not
    // forever.
    start(nextUrl = null) {
      attach()
      reset()
      url = nextUrl
      if (url === null) {
        silence()
        setPhase(LivePhase.NONE)
        later(giveUpOrDefer, giveUpAfterMs)
        return
      }

      setPhase(LivePhase.CONNECTING)
      open()
    },
    stop() {
      reset()
      url = null
      silence()
      detach()
      phase = null
    },
    getPhase() {
      return phase
    },
  }
}
