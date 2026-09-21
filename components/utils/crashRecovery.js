// What happens after a render crash on a screen nobody is watching.
//
// A totem cannot sit on an error screen until someone walks over with the
// remote, so a crash is reported for remote diagnosis and the app reloads
// itself after a short pause. React and Firebase stay out of this file: the
// error boundary hands in the reporter, the reload and the fallback so the
// timing and the guards can be tested with fakes.

export const RECOVERY_DELAY_MS = 10000
export const MAX_ERROR_MESSAGE_LENGTH = 500
export const MAX_ERROR_STACK_LENGTH = 1000

// The record written to devices/{id}/lastError. Lengths are bounded so a
// runaway stack can never bloat the device node.
export function describeCrash(error, info, at) {
  const rawMessage =
    error && typeof error === 'object' && 'message' in error
      ? error.message
      : error

  return {
    message: String(rawMessage ?? 'Unknown error').slice(0, MAX_ERROR_MESSAGE_LENGTH),
    stack: String(info?.componentStack ?? '').slice(0, MAX_ERROR_STACK_LENGTH),
    at,
  }
}

export function createCrashRecovery({
  report,
  reload,
  recover,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = Date.now,
  delayMs = RECOVERY_DELAY_MS,
}) {
  let timer = null
  let disposed = false

  const attemptReport = (crash) => {
    try {
      const result = report(crash)
      if (result && typeof result.catch === 'function') {
        // Without network there is nothing to do; the reload still happens.
        result.catch(() => {})
      }
    } catch (_error) {
      // A failing reporter must never keep the screen from recovering.
    }
  }

  const attemptRecovery = async () => {
    timer = null
    if (disposed) return

    try {
      await reload()
    } catch (_error) {
      // In development, or when the updates module is unavailable, a plain
      // re-render is the best that can be done.
      try {
        recover()
      } catch (_recoverError) {
        // Nothing left to try; a further crash re-enters handleCrash.
      }
    }
  }

  return {
    handleCrash(error, info) {
      if (disposed) return

      attemptReport(describeCrash(error, info, now()))

      // A second crash while a reload is already pending must not queue a
      // second reload: one recovery per pause, never a tight loop.
      if (timer !== null) return

      timer = schedule(attemptRecovery, delayMs)
    },
    dispose() {
      disposed = true
      if (timer !== null) {
        cancel(timer)
        timer = null
      }
    },
    isRecoveryPending() {
      return timer !== null
    },
  }
}
