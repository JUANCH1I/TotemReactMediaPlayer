import {
  LIVE_GIVE_UP_MS,
  LiveRecoveryAction,
  createLiveStallWatchdog,
  monotonicNow,
  resolveLiveRecovery,
} from './liveRecovery'

// The life of one live broadcast on a screen, kept out of React so it can be
// driven by a fake player and a fake clock.
//
// A session opens a URL, watches it, reopens it with backoff when it drops,
// and after a long enough streak of failures asks to give the screen back.
// It never asks while the totem itself is offline (that is the totem's
// outage, not the broadcast's), and it never leaves audio running after the
// dashboard clears the broadcast.

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
  watchdogOptions = {},
}) {
  let url = null
  let attempt = 0
  let failingSinceMs = null
  let attemptFailed = false
  let gaveUp = false
  let timer = null
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

  const silence = () => {
    player.pause()
    player.replace(null)
  }

  const watchdog = createLiveStallWatchdog({
    onStall: () => fail('playback stalled'),
    // Only real progress proves a recovery worked; "playing" alone does not.
    onHealthy: () => {
      failingSinceMs = null
      attempt = 0
    },
    schedule,
    cancel,
    ...watchdogOptions,
  })

  const open = () => {
    attemptFailed = false
    watchdog.start()
    player.replace({ uri: url, contentType: 'hls' })
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
    watchdog.stop()
    const nowMs = now()
    if (failingSinceMs === null) failingSinceMs = nowMs
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
      } else if (status === 'loading') {
        watchdog.allowGrace()
      } else if (status === 'readyToPlay' && !player.playing) {
        player.play()
      }
    },
    handlePlaying({ isPlaying }) {
      if (url === null || attemptFailed || gaveUp) return

      if (isPlaying) {
        setPhase(LivePhase.PLAYING)
      } else {
        watchdog.allowGrace()
      }
    },
    handleProgress({ currentTime }) {
      if (url === null || attemptFailed || gaveUp) return

      watchdog.recordProgress(currentTime)
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
      player.addListener('timeUpdate', handlers.handleProgress),
      player.addListener('playToEnd', handlers.handleEnd),
    ]
  }

  const detach = () => {
    subscriptions.forEach((subscription) => subscription.remove())
    subscriptions = []
  }

  const reset = () => {
    clearTimer()
    watchdog.stop()
    attemptFailed = false
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
