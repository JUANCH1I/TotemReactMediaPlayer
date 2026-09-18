import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// A live screen must keep reconnecting through short outages without
// hammering the origin, and must hand itself back before a dead broadcast
// leaves a dining room black for the night.

async function loadModule() {
  const url = new URL('../components/utils/liveRecovery.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ Date, Math, Number, setTimeout, clearTimeout })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })
  await module.link((specifier) => {
    if (specifier !== './mediaRecoveryPolicy') {
      throw new Error(`Unexpected import: ${specifier}`)
    }

    const policyUrl = new URL('../components/utils/mediaRecoveryPolicy.js', import.meta.url)
    return new vm.SourceTextModule(readFileSync(policyUrl, 'utf8'), {
      context,
      identifier: policyUrl.href,
    })
  })
  await module.evaluate()
  return module.namespace
}

const plain = (value) => JSON.parse(JSON.stringify(value))

const {
  LIVE_GIVE_UP_MS,
  LIVE_HEALTHY_AFTER_SECONDS,
  LiveRecoveryAction,
  createLiveStallWatchdog,
  monotonicNow,
  resolveLiveRecovery,
} = await loadModule()

assert.equal(LIVE_GIVE_UP_MS, 10 * 60 * 1000)
assert.equal(LIVE_HEALTHY_AFTER_SECONDS, 15)

{
  // Short outages: the single-item backoff, 2 s doubling to a 30 s ceiling.
  const startedAt = 1_000_000
  const delays = [1, 2, 3, 4, 5, 6, 40].map(
    (attempt) =>
      resolveLiveRecovery({ failingSinceMs: startedAt, nowMs: startedAt + 60_000, attempt })
        .delayMs
  )
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000, 30000])
  for (const attempt of [1, 6, 40]) {
    assert.equal(
      resolveLiveRecovery({ failingSinceMs: startedAt, nowMs: startedAt + 60_000, attempt })
        .action,
      LiveRecoveryAction.RETRY
    )
  }
}

{
  // The long outage: just before the limit it still retries; at the limit it
  // gives the screen back, whatever the attempt count.
  const startedAt = 5_000_000
  assert.deepEqual(
    plain(
      resolveLiveRecovery({
        failingSinceMs: startedAt,
        nowMs: startedAt + LIVE_GIVE_UP_MS - 1,
        attempt: 25,
      })
    ),
    { action: LiveRecoveryAction.RETRY, delayMs: 30000 }
  )
  assert.deepEqual(
    plain(
      resolveLiveRecovery({
        failingSinceMs: startedAt,
        nowMs: startedAt + LIVE_GIVE_UP_MS,
        attempt: 25,
      })
    ),
    { action: LiveRecoveryAction.GIVE_UP, delayMs: 0 }
  )
  assert.equal(
    resolveLiveRecovery({ failingSinceMs: startedAt, nowMs: startedAt + LIVE_GIVE_UP_MS, attempt: 1 })
      .action,
    LiveRecoveryAction.GIVE_UP,
    'The streak length, not the attempt count, decides.'
  )
  assert.equal(
    resolveLiveRecovery({
      failingSinceMs: startedAt,
      nowMs: startedAt + 90_000,
      attempt: 3,
      giveUpAfterMs: 60_000,
    }).action,
    LiveRecoveryAction.GIVE_UP,
    'The limit is adjustable.'
  )
}

{
  // The streak is measured on an injectable monotonic clock, never on the
  // wall clock: an RTC jump after an NTP sync must not look like ten minutes
  // of failure.
  let ticks = 100_000
  const now = () => ticks
  const failingSinceMs = now()
  ticks += LIVE_GIVE_UP_MS - 1
  assert.equal(
    resolveLiveRecovery({ failingSinceMs, attempt: 9, now }).action,
    LiveRecoveryAction.RETRY,
    'nowMs defaults to the injected clock.'
  )
  ticks += 1
  assert.equal(resolveLiveRecovery({ failingSinceMs, attempt: 9, now }).action, LiveRecoveryAction.GIVE_UP)
  // Without performance.now in this realm the default falls back to Date.now,
  // but it is a function either way.
  assert.equal(typeof monotonicNow(), 'number')
}

{
  // Garbage timestamps never give up by accident.
  for (const failingSinceMs of [null, undefined, Number.NaN]) {
    assert.equal(
      resolveLiveRecovery({ failingSinceMs, nowMs: Date.now(), attempt: 1 }).action,
      LiveRecoveryAction.RETRY
    )
  }
}

// The stall watchdog: one stream, one session at a time.
function createScheduler() {
  let now = 0
  let nextId = 1
  const scheduled = new Map()
  const callbacks = new Map()

  return {
    schedule: (callback, delay) => {
      const id = nextId
      nextId += 1
      scheduled.set(id, { callback, dueAt: now + delay })
      callbacks.set(id, callback)
      return id
    },
    cancel: (id) => scheduled.delete(id),
    advance: (milliseconds) => {
      now += milliseconds
      for (const [id, task] of [...scheduled.entries()].sort(
        (left, right) => left[1].dueAt - right[1].dueAt
      )) {
        if (task.dueAt > now) continue
        if (!scheduled.delete(id)) continue
        task.callback()
      }
    },
    latestId: () => nextId - 1,
    invokeEvenIfCancelled: (id) => callbacks.get(id)?.(),
    activeCount: () => scheduled.size,
  }
}

function createHarness() {
  const scheduler = createScheduler()
  let stalls = 0
  let healthy = 0
  const watchdog = createLiveStallWatchdog({
    onStall: () => {
      stalls += 1
    },
    onHealthy: () => {
      healthy += 1
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    startupGraceMs: 100,
    stallThresholdMs: 50,
    minimumProgressSeconds: 0.25,
    healthyAfterSeconds: 3,
  })
  return { scheduler, watchdog, stalls: () => stalls, healthy: () => healthy }
}

{
  const { scheduler, watchdog, stalls } = createHarness()
  watchdog.start()
  scheduler.advance(80)
  watchdog.recordProgress(100.5)
  scheduler.advance(10)
  watchdog.recordProgress(101)
  scheduler.advance(40)
  watchdog.recordProgress(101.5)
  scheduler.advance(40)
  assert.equal(stalls(), 0, 'Progress keeps the stream alive.')
  scheduler.advance(10)
  assert.equal(stalls(), 1, 'A frozen stream trips the watchdog once.')
  scheduler.advance(500)
  assert.equal(stalls(), 1)
}

{
  // A stream is healthy only after real, accumulated progress; the first
  // reading is where a live stream happens to start, not progress, and
  // "playing" without movement never counts.
  const { scheduler, watchdog, healthy } = createHarness()
  watchdog.start()
  watchdog.recordProgress(500)
  assert.equal(healthy(), 0, 'The first reading is a starting point.')
  watchdog.recordProgress(501)
  watchdog.recordProgress(502)
  scheduler.advance(10)
  assert.equal(healthy(), 0, 'Two seconds is not enough.')
  watchdog.recordProgress(503)
  assert.equal(healthy(), 1, 'Three seconds of movement is.')
  watchdog.recordProgress(510)
  assert.equal(healthy(), 1, 'Reported once per session.')
  watchdog.start()
  watchdog.recordProgress(0)
  watchdog.recordProgress(0.1)
  watchdog.recordProgress(0.2)
  assert.equal(healthy(), 1, 'Jitter below the progress floor is not movement.')
}

{
  const { scheduler, watchdog, stalls } = createHarness()
  watchdog.start()
  scheduler.advance(90)
  watchdog.allowGrace()
  scheduler.advance(90)
  assert.equal(stalls(), 0, 'Rebuffering earns fresh grace.')
  watchdog.recordProgress(0.1)
  scheduler.advance(20)
  assert.equal(stalls(), 1, 'Negligible progress does not conceal a stall.')
}

{
  const { scheduler, watchdog, stalls } = createHarness()
  watchdog.start()
  const staleTimer = scheduler.latestId()
  watchdog.start()
  scheduler.invokeEvenIfCancelled(staleTimer)
  assert.equal(stalls(), 0, 'A timer from a previous attempt cannot fire into the next.')
  scheduler.advance(100)
  assert.equal(stalls(), 1)
}

{
  const { scheduler, watchdog, stalls } = createHarness()
  watchdog.start()
  const timer = scheduler.latestId()
  watchdog.stop()
  assert.equal(scheduler.activeCount(), 0)
  scheduler.invokeEvenIfCancelled(timer)
  watchdog.recordProgress(5)
  scheduler.advance(1000)
  assert.equal(stalls(), 0, 'A stopped watchdog is inert, whatever arrives late.')
}

console.log('Live recovery behavior checks passed.')
