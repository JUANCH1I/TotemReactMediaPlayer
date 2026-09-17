import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// The reporter is the answer to "is this totem alive?", so the cases that
// matter are a screen coming back after an outage and a screen that never says
// goodbye.

const loadReporter = async () => {
  const url = new URL('../components/utils/presenceReporter.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ console, setInterval, clearInterval })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })

  await module.link(() => {
    throw new Error('The reporter must not import anything')
  })
  await module.evaluate()

  return module.namespace
}

const createFakeClient = () => {
  const writes = []
  const disconnectPayloads = []
  let listener = null
  let unwatched = 0

  return {
    writes,
    disconnectPayloads,
    get watching() {
      return listener !== null
    },
    get unwatched() {
      return unwatched
    },
    connect() {
      listener?.(true)
    },
    drop() {
      listener?.(false)
    },
    watchConnection(callback) {
      listener = callback
      return () => {
        listener = null
        unwatched += 1
      }
    },
    armDisconnect(payload) {
      disconnectPayloads.push(payload)
    },
    write(payload) {
      writes.push(payload)
    },
  }
}

const createManualClock = () => {
  let tick = null

  return {
    schedule: (callback) => {
      tick = callback
      return 1
    },
    cancel: () => {
      tick = null
    },
    get scheduled() {
      return tick !== null
    },
    run() {
      tick?.()
    },
  }
}

const { createPresenceReporter, SERVER_TIME } = await loadReporter()

{
  // A connected totem announces itself and keeps a heartbeat going.
  const client = createFakeClient()
  const clock = createManualClock()
  const reporter = createPresenceReporter({
    client,
    details: { appVersion: '1.2.3' },
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  reporter.start()
  assert.equal(client.watching, true)
  assert.equal(client.writes.length, 0, 'Nothing is written before the connection is up')

  client.connect()

  assert.equal(
    client.disconnectPayloads.length,
    1,
    'The disconnect report is armed before anything else'
  )
  // Compared field by field: objects built inside the sandbox are not
  // reference-equal to this realm's.
  const goodbye = client.disconnectPayloads[0]
  assert.equal(goodbye.online, false)
  assert.equal(goodbye.isScreenOn, false)
  assert.equal(goodbye.lastSeen, SERVER_TIME)

  const [first] = client.writes
  assert.equal(first.online, true)
  assert.equal(first.isScreenOn, true, 'The field the dashboard already reads stays truthful')
  assert.equal(first.lastSeen, SERVER_TIME)
  assert.equal(first.bootedAt, SERVER_TIME, 'The first connection records the boot')
  assert.equal(first.appVersion, '1.2.3')

  clock.run()
  const [, beat] = client.writes
  assert.deepEqual(Object.keys(beat).sort(), ['lastSeen', 'online'], 'The heartbeat is small')
  assert.equal(beat.online, true)
  assert.equal(beat.lastSeen, SERVER_TIME)

  reporter.stop()
  assert.equal(clock.scheduled, false, 'Stopping ends the heartbeat')
  assert.equal(client.unwatched, 1)
}

{
  // The internet drops and comes back: the totem must re-arm its disconnect
  // report, because Firebase forgets it when the connection dies.
  const client = createFakeClient()
  const clock = createManualClock()
  const reporter = createPresenceReporter({
    client,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  reporter.start()
  client.connect()
  client.drop()

  assert.equal(clock.scheduled, false, 'A disconnected totem does not beat')

  client.connect()

  assert.equal(client.disconnectPayloads.length, 2, 'The disconnect report is armed again')
  assert.equal(clock.scheduled, true)

  const boots = client.writes.filter((payload) => 'bootedAt' in payload)
  assert.equal(boots.length, 1, 'Reconnecting is not a reboot')

  reporter.stop()
}

{
  // A failing database must never take the player down with it.
  const clock = createManualClock()
  const brokenClient = {
    watchConnection: (callback) => {
      callback(true)
      return () => {}
    },
    armDisconnect: () => {
      throw new Error('offline')
    },
    write: () => {
      throw new Error('offline')
    },
  }

  const reporter = createPresenceReporter({
    client: brokenClient,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  reporter.start()
  reporter.stop()
}

console.log('Presence reporter behavior checks passed.')
