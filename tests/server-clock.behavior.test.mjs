import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// The clock is what the whole group agrees on, so a wrong reading puts a
// screen out of step. It must never block playback waiting for the server and
// must let go of its listener when the player goes away.

async function loadModule() {
  const url = new URL('../components/utils/serverClock.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ Date, Number, Promise })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })
  await module.link(() => {
    throw new Error('The server clock must stay free of runtime dependencies.')
  })
  await module.evaluate()
  return module.namespace
}

const { createServerClock } = await loadModule()

function createHarness() {
  let localNow = 1_000_000
  let listener = null
  let subscriptions = 0
  let unsubscriptions = 0
  const clock = createServerClock({
    subscribeOffset: (callback) => {
      subscriptions += 1
      listener = callback
      return () => {
        unsubscriptions += 1
        listener = null
      }
    },
    now: () => localNow,
  })
  return {
    clock,
    push: (value) => listener?.(value),
    advance: (ms) => {
      localNow += ms
    },
    subscriptions: () => subscriptions,
    unsubscriptions: () => unsubscriptions,
    hasListener: () => listener !== null,
  }
}

{
  // Before the server answers, the clock is simply the local one.
  const { clock, push, advance, subscriptions } = createHarness()
  assert.equal(clock.hasOffset(), false)
  assert.equal(clock.now(), 1_000_000)
  assert.equal(subscriptions(), 0, 'Nothing is subscribed until start().')

  clock.start()
  clock.start()
  assert.equal(subscriptions(), 1, 'Starting twice must not double-subscribe.')

  push(2500)
  assert.equal(clock.hasOffset(), true)
  assert.equal(clock.offset(), 2500)
  assert.equal(clock.now(), 1_002_500, 'Server time is local time plus the offset.')
  advance(100)
  assert.equal(clock.now(), 1_002_600)

  push(-4000)
  assert.equal(clock.now(), 996_100, 'A later offset (the server refining it) replaces the previous one.')
  assert.equal(await clock.ready, 2500, 'ready resolves with the first offset.')
}

{
  // Garbage from the wire never becomes an offset.
  const { clock, push } = createHarness()
  clock.start()
  for (const junk of [null, undefined, '2500', Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
    push(junk)
    assert.equal(clock.hasOffset(), false, `Ignored: ${String(junk)}`)
    assert.equal(clock.now(), 1_000_000)
  }
  push(0)
  assert.equal(clock.hasOffset(), true, 'A zero offset is a valid answer.')
}

{
  // Stopping releases the listener exactly once; a stopped clock keeps its
  // last reading so a schedule can still be computed while reconnecting.
  const { clock, push, unsubscriptions, hasListener } = createHarness()
  clock.start()
  push(1000)
  clock.stop()
  clock.stop()
  assert.equal(unsubscriptions(), 1)
  assert.equal(hasListener(), false)
  assert.equal(clock.now(), 1_001_000)
  assert.equal(clock.hasOffset(), true)
}

{
  // The default clock reads Date.now, so the offset is applied to real time.
  let received = null
  const clock = createServerClock({
    subscribeOffset: (callback) => {
      received = callback
      return () => {}
    },
  })
  clock.start()
  received(60_000)
  const wall = Date.now()
  assert.ok(clock.now() >= wall + 60_000 - 50 && clock.now() <= wall + 60_000 + 50)
}

console.log('Server clock behavior checks passed.')
