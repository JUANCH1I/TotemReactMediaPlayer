// A clock that reads the server's time instead of the television's.
//
// Screens synchronize on server time because their own clocks are whatever the
// vendor shipped, often off by minutes. RTDB tells every client how far its
// clock is from the server's, so adding that offset to Date.now() gives every
// member of a group the same reading. Until the first offset arrives the clock
// simply reports local time: a stale schedule is better than no playback.

export function createServerClock({ subscribeOffset, now = Date.now }) {
  let offsetMs = 0
  let offsetKnown = false
  let unsubscribe = null
  let resolveReady = null
  const ready = new Promise((resolve) => {
    resolveReady = resolve
  })

  return {
    start() {
      if (unsubscribe !== null) return

      unsubscribe = subscribeOffset((value) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return

        offsetMs = value
        if (!offsetKnown) {
          offsetKnown = true
          resolveReady(value)
        }
      })
    },
    stop() {
      if (unsubscribe === null) return

      unsubscribe()
      unsubscribe = null
    },
    now() {
      return now() + offsetMs
    },
    offset() {
      return offsetMs
    },
    hasOffset() {
      return offsetKnown
    },
    ready,
  }
}
