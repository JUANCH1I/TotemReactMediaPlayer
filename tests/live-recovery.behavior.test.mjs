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
  LIVE_HEALTHY_PLAYING_MS,
  LIVE_STALL_MS,
  LIVE_STARTUP_GRACE_MS,
  LiveRecoveryAction,
  createLiveStallWatchdog,
  monotonicNow,
  resolveLiveRecovery,
} = await loadModule()

assert.equal(LIVE_GIVE_UP_MS, 10 * 60 * 1000)
assert.equal(LIVE_HEALTHY_PLAYING_MS, 5000)
assert.equal(LIVE_STARTUP_GRACE_MS, 20000)
assert.equal(LIVE_STALL_MS, 12000)

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

// The stall watchdog: one stream, one session at a time, judged only by the
// player's playing state. The reported position is never consulted.
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
  const watchdog = createLiveStallWatchdog({
    onStall: () => {
      stalls += 1
    },
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    startupGraceMs: 100,
    stallMs: 50,
  })
  return { scheduler, watchdog, stalls: () => stalls }
}

{
  // A stream that never reaches "playing" trips the startup grace once.
  const { scheduler, watchdog, stalls } = createHarness()
  watchdog.start()
  scheduler.advance(99)
  assert.equal(stalls(), 0)
  scheduler.advance(1)
  assert.equal(stalls(), 1)
  scheduler.advance(1000)
  assert.equal(stalls(), 1)
}

{
  // Buffering before the first frame does not extend the startup grace.
  const { scheduler, watchdog, stalls } = createHarness()
  watchdog.start()
  scheduler.advance(90)
  watchdog.setPlaying(false)
  scheduler.advance(10)
  assert.equal(stalls(), 1)
}

{
  // Playing is healthy for as long as it lasts, whatever the position does;
  // short rebuffers are absorbed; a long one is a stall, reported once.
  const { scheduler, watchdog, stalls } = createHarness()
  watchdog.start()
  scheduler.advance(80)
  watchdog.setPlaying(true)
  scheduler.advance(10_000)
  assert.equal(stalls(), 0, 'Continuous playback never stalls.')
  watchdog.setPlaying(false)
  scheduler.advance(49)
  watchdog.setPlaying(true)
  scheduler.advance(1000)
  assert.equal(stalls(), 0, 'A short rebuffer is not a stall.')
  watchdog.setPlaying(false)
  scheduler.advance(49)
  assert.equal(stalls(), 0)
  scheduler.advance(1)
  assert.equal(stalls(), 1, 'Buffering for the threshold is a stall.')
  watchdog.setPlaying(true)
  watchdog.setPlaying(false)
  scheduler.advance(1000)
  assert.equal(stalls(), 1, 'A tripped session stays quiet until restarted.')
}

{
  // A timer from a previous attempt cannot fire into the next.
  const { scheduler, watchdog, stalls } = createHarness()
  watchdog.start()
  const staleTimer = scheduler.latestId()
  watchdog.start()
  scheduler.invokeEvenIfCancelled(staleTimer)
  assert.equal(stalls(), 0)
  scheduler.advance(100)
  assert.equal(stalls(), 1)
}

{
  // A stopped watchdog is inert, whatever arrives late.
  const { scheduler, watchdog, stalls } = createHarness()
  watchdog.start()
  const timer = scheduler.latestId()
  watchdog.stop()
  assert.equal(scheduler.activeCount(), 0)
  scheduler.invokeEvenIfCancelled(timer)
  watchdog.setPlaying(false)
  scheduler.advance(1000)
  assert.equal(stalls(), 0)
}

console.log('Live recovery behavior checks passed.')
