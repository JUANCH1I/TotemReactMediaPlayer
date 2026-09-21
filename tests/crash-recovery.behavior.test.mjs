import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// A crash on a totem must end in a reload, once, with a trace left behind for
// whoever looks at the dashboard later. These cases pin the report, the pause
// before reloading, the fallback when reloading is impossible, and the guards
// that keep a crashing screen from spinning.

const loadRecovery = async () => {
  const url = new URL('../components/utils/crashRecovery.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ console, setTimeout, clearTimeout, Date })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })

  await module.link(() => {
    throw new Error('Crash recovery must not import anything')
  })
  await module.evaluate()

  return module.namespace
}

const createHarness = ({ reloadFails = false } = {}) => {
  const reports = []
  const scheduled = []
  const cancelled = []
  let reloads = 0
  let recovers = 0

  return {
    reports,
    scheduled,
    cancelled,
    get reloads() {
      return reloads
    },
    get recovers() {
      return recovers
    },
    options: {
      report: (crash) => {
        reports.push(crash)
        return Promise.resolve()
      },
      reload: async () => {
        reloads += 1
        if (reloadFails) throw new Error('reloadAsync is not available')
      },
      recover: () => {
        recovers += 1
      },
      schedule: (callback, delay) => {
        const handle = { callback, delay }
        scheduled.push(handle)
        return handle
      },
      cancel: (handle) => {
        cancelled.push(handle)
      },
      now: () => 1700000000000,
    },
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

const {
  createCrashRecovery,
  describeCrash,
  RECOVERY_DELAY_MS,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_ERROR_STACK_LENGTH,
} = await loadRecovery()

{
  // The record is bounded and survives odd error shapes.
  const long = 'x'.repeat(5000)
  const crash = describeCrash(new Error(long), { componentStack: long }, 42)
  assert.equal(crash.message.length, MAX_ERROR_MESSAGE_LENGTH)
  assert.equal(crash.stack.length, MAX_ERROR_STACK_LENGTH)
  assert.equal(crash.at, 42)

  assert.equal(describeCrash('plain string', undefined, 1).message, 'plain string')
  assert.equal(describeCrash(null, null, 1).message, 'Unknown error')
  assert.equal(describeCrash(undefined, {}, 1).stack, '')
}

{
  // One crash: one report, one reload scheduled after the pause.
  const harness = createHarness()
  const recovery = createCrashRecovery(harness.options)

  recovery.handleCrash(new Error('boom'), { componentStack: '\n in Foo' })

  assert.equal(harness.reports.length, 1)
  // Records cross the vm realm, so fields are compared rather than prototypes.
  assert.equal(harness.reports[0].message, 'boom')
  assert.equal(harness.reports[0].stack, '\n in Foo')
  assert.equal(harness.reports[0].at, 1700000000000)
  assert.equal(harness.scheduled.length, 1)
  assert.equal(harness.scheduled[0].delay, RECOVERY_DELAY_MS)
  assert.equal(recovery.isRecoveryPending(), true)

  await harness.scheduled[0].callback()
  assert.equal(harness.reloads, 1)
  assert.equal(harness.recovers, 0, 'A successful reload needs no fallback.')
  assert.equal(recovery.isRecoveryPending(), false)
}

{
  // A second crash while the pause runs is reported but never queues a second
  // reload.
  const harness = createHarness()
  const recovery = createCrashRecovery(harness.options)

  recovery.handleCrash(new Error('first'))
  recovery.handleCrash(new Error('second'))

  assert.equal(harness.reports.length, 2)
  assert.equal(harness.scheduled.length, 1, 'One recovery per pause.')
}

{
  // When reloading is impossible (development, module missing) the screen is
  // re-rendered instead.
  const harness = createHarness({ reloadFails: true })
  const recovery = createCrashRecovery(harness.options)

  recovery.handleCrash(new Error('boom'))
  await harness.scheduled[0].callback()

  assert.equal(harness.reloads, 1)
  assert.equal(harness.recovers, 1)
}

{
  // A reporter that rejects or throws never blocks the recovery.
  const rejecting = createHarness()
  rejecting.options.report = () => Promise.reject(new Error('offline'))
  const first = createCrashRecovery(rejecting.options)
  first.handleCrash(new Error('boom'))
  await flush()
  assert.equal(rejecting.scheduled.length, 1)

  const throwing = createHarness()
  throwing.options.report = () => {
    throw new Error('no device id')
  }
  const second = createCrashRecovery(throwing.options)
  second.handleCrash(new Error('boom'))
  assert.equal(throwing.scheduled.length, 1)
}

{
  // Unmounting cancels the pending reload, and a late timer does nothing.
  const harness = createHarness()
  const recovery = createCrashRecovery(harness.options)

  recovery.handleCrash(new Error('boom'))
  recovery.dispose()

  assert.equal(harness.cancelled.length, 1)
  assert.equal(harness.cancelled[0], harness.scheduled[0])
  assert.equal(recovery.isRecoveryPending(), false)

  await harness.scheduled[0].callback()
  assert.equal(harness.reloads, 0, 'A disposed recovery must not reload.')

  recovery.handleCrash(new Error('after dispose'))
  assert.equal(harness.reports.length, 1, 'A disposed recovery must not report.')
  assert.equal(harness.scheduled.length, 1)
}

{
  // The boundary stays thin and sits around the navigator.
  const boundary = readFileSync(
    new URL('../components/ErrorBoundary.js', import.meta.url),
    'utf8'
  )
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

  assert.match(boundary, /createCrashRecovery\(\{/)
  assert.match(boundary, /Updates\.reloadAsync\(\)/)
  assert.match(boundary, /`devices\/\$\{id\}`/)
  assert.match(boundary, /\{ lastError: crash \}/)
  assert.match(boundary, /this\.recovery\.dispose\(\)/)
  assert.doesNotMatch(boundary, /setTimeout\(|setInterval\(/, 'Timers belong to the recovery.')
  assert.match(app, /<ErrorBoundary>\s*<AppNavigator \/>\s*<\/ErrorBoundary>/)
}

console.log('Crash recovery behavior checks passed.')
