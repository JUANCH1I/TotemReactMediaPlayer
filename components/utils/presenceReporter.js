// Answers "is this totem alive, and when did we last hear from it?".
//
// The database had no timestamp anywhere, so a screen unplugged a year ago
// still looked exactly like one playing right now. Two things fix that: a
// heartbeat written while the totem is connected, and a payload the server
// writes on its behalf when the connection drops, which also covers a power
// cut where the app never gets to say goodbye.
//
// Firebase stays out of this file so the behaviour can be tested without it:
// the caller passes a client, and SERVER_TIME is swapped for the server
// timestamp on the way out.

export const SERVER_TIME = Symbol('server-time')
export const HEARTBEAT_INTERVAL_MS = 60000

export function createPresenceReporter({
  client,
  details = {},
  schedule = setInterval,
  cancel = clearInterval,
  heartbeatMs = HEARTBEAT_INTERVAL_MS,
}) {
  let unwatch = null
  let heartbeat = null
  let destroyed = false
  let booted = false

  const stopHeartbeat = () => {
    if (heartbeat === null) return

    cancel(heartbeat)
    heartbeat = null
  }

  const write = (payload) => {
    try {
      const result = client.write(payload)
      if (result && typeof result.catch === 'function') {
        result.catch((error) => console.error('Unable to report presence:', error))
      }
    } catch (error) {
      console.error('Unable to report presence:', error)
    }
  }

  const handleConnection = (connected) => {
    if (destroyed) return

    if (!connected) {
      stopHeartbeat()
      return
    }

    try {
      // Registered before the first write: if the connection drops between the
      // two, the server still knows the screen went away.
      client.armDisconnect({
        online: false,
        isScreenOn: false,
        lastSeen: SERVER_TIME,
      })
    } catch (error) {
      console.error('Unable to arm the disconnect report:', error)
    }

    write({
      online: true,
      isScreenOn: true,
      lastSeen: SERVER_TIME,
      ...(booted ? {} : { bootedAt: SERVER_TIME }),
      ...details,
    })
    booted = true

    stopHeartbeat()
    heartbeat = schedule(() => {
      write({ online: true, lastSeen: SERVER_TIME })
    }, heartbeatMs)
  }

  return {
    start() {
      if (destroyed || unwatch) return

      try {
        unwatch = client.watchConnection(handleConnection)
      } catch (error) {
        console.error('Unable to watch the connection state:', error)
      }
    },
    stop() {
      destroyed = true
      stopHeartbeat()

      try {
        unwatch?.()
      } catch (error) {
        console.error('Unable to stop watching the connection state:', error)
      }

      unwatch = null
    },
  }
}
