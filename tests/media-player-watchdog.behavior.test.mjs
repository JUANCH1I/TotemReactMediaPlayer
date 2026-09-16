import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sourcePath = process.env.MEDIA_PLAYER_SOURCE
  ? new URL(`file://${process.env.MEDIA_PLAYER_SOURCE}`)
  : new URL('../components/MediaPlayer.js', import.meta.url)
const source = readFileSync(sourcePath, 'utf8')
const transitionStart = source.indexOf('function claimPlaybackTransition')
const transitionEnd = source.indexOf(
  '\n}\n\nfunction createVideoStallWatchdog',
  transitionStart
)
assert.notEqual(
  transitionStart,
  -1,
  'Playback completion and failure paths must share one transition gate.'
)
assert.notEqual(transitionEnd, -1, 'The transition gate must remain testable.')
const transitionSource = source.slice(transitionStart, transitionEnd + 2)
const claimPlaybackTransition = Function(
  `${transitionSource}; return claimPlaybackTransition`
)()

{
  const activeGenerationRef = { current: 20 }
  const transitionHandledGenerationRef = { current: null }
  const claim = () =>
    claimPlaybackTransition(
      20,
      activeGenerationRef,
      transitionHandledGenerationRef
    )

  assert.equal(claim(), true, 'The first terminal signal must win.')
  assert.equal(claim(), false, 'A concurrent native error must be deduplicated.')
  assert.equal(claim(), false, 'A concurrent playToEnd/watchdog signal must be deduplicated.')
  assert.equal(
    claimPlaybackTransition(
      19,
      activeGenerationRef,
      transitionHandledGenerationRef
    ),
    false,
    'A stale terminal signal must never claim the active transition.'
  )
}

const watchdogStart = source.indexOf('function createVideoStallWatchdog')
const watchdogEnd = source.indexOf('\n}\n\nexport default function', watchdogStart)

assert.notEqual(watchdogStart, -1, 'MediaPlayer must define a video stall watchdog.')
assert.notEqual(watchdogEnd, -1, 'The watchdog must remain independently testable.')

const watchdogSource = source.slice(watchdogStart, watchdogEnd + 2)
const createVideoStallWatchdog = Function(
  `${watchdogSource}; return createVideoStallWatchdog`
)()

function createScheduler() {
  let now = 0
  let nextId = 1
  const scheduled = new Map()
  const callbacks = new Map()

  const schedule = (callback, delay) => {
    const id = nextId
    nextId += 1
    const task = { callback, dueAt: now + delay }
    scheduled.set(id, task)
    callbacks.set(id, callback)
    return id
  }
  const cancel = (id) => scheduled.delete(id)
  const advance = (milliseconds) => {
    now += milliseconds
    const dueTasks = [...scheduled.entries()]
      .filter(([, task]) => task.dueAt <= now)
      .sort((left, right) => left[1].dueAt - right[1].dueAt)
    for (const [id, task] of dueTasks) {
      if (!scheduled.delete(id)) continue
      task.callback()
    }
  }

  return {
    schedule,
    cancel,
    advance,
    latestId: () => nextId - 1,
    invokeEvenIfCancelled: (id) => callbacks.get(id)?.(),
    activeCount: () => scheduled.size,
  }
}

function createHarness() {
  const scheduler = createScheduler()
  const stalls = []
  const watchdog = createVideoStallWatchdog({
    onStall: (generation) => stalls.push(generation),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    startupGraceMs: 100,
    stallThresholdMs: 50,
    minimumProgressSeconds: 0.25,
  })
  return { scheduler, stalls, watchdog }
}

{
  const { scheduler, stalls, watchdog } = createHarness()
  watchdog.activate(1)
  scheduler.advance(80)
  watchdog.recordProgress(1, 0.5)
  scheduler.advance(40)
  watchdog.recordProgress(1, 1)
  scheduler.advance(40)
  watchdog.recordProgress(1, 1.5)
  scheduler.advance(40)
  assert.deepEqual(stalls, [], 'Meaningful progress must keep the watchdog alive.')
  scheduler.advance(10)
  assert.deepEqual(stalls, [1], 'A true playback stall must trigger once.')
  scheduler.advance(500)
  assert.deepEqual(stalls, [1])
}

{
  const { scheduler, stalls, watchdog } = createHarness()
  watchdog.activate(2)
  scheduler.advance(90)
  watchdog.allowGrace(2)
  scheduler.advance(90)
  assert.deepEqual(stalls, [], 'Short startup or rebuffering must receive fresh grace.')
  watchdog.recordProgress(2, 3)
  scheduler.advance(49)
  assert.deepEqual(stalls, [])
  scheduler.advance(1)
  assert.deepEqual(stalls, [2])
}

{
  const { scheduler, stalls, watchdog } = createHarness()
  watchdog.activate(8)
  scheduler.advance(80)
  watchdog.recordProgress(8, 0.1)
  scheduler.advance(20)
  assert.deepEqual(
    stalls,
    [8],
    'Negligible playback-time changes must not conceal a true stall.'
  )
}

{
  const { scheduler, stalls, watchdog } = createHarness()
  watchdog.activate(9)
  watchdog.recordProgress(9, 10)
  scheduler.advance(49)
  watchdog.recordProgress(9, 0)
  scheduler.advance(49)
  assert.deepEqual(stalls, [], 'A meaningful time rollback must reset the baseline.')
  scheduler.advance(1)
  assert.deepEqual(stalls, [9])
}

{
  const { scheduler, stalls, watchdog } = createHarness()
  watchdog.activate(3)
  const staleTimer = scheduler.latestId()
  watchdog.activate(4)
  scheduler.invokeEvenIfCancelled(staleTimer)
  assert.deepEqual(stalls, [], 'A stale-generation timer must not recover a newer item.')
  scheduler.advance(100)
  assert.deepEqual(stalls, [4])
}

{
  const { scheduler, stalls, watchdog } = createHarness()
  watchdog.activate(5)
  const staleSameUrlTimer = scheduler.latestId()
  watchdog.deactivate(5)
  watchdog.activate(6)
  scheduler.invokeEvenIfCancelled(staleSameUrlTimer)
  assert.deepEqual(
    stalls,
    [],
    'Consecutive same-URL activations must remain isolated by generation.'
  )
  scheduler.advance(100)
  assert.deepEqual(stalls, [6])
}

{
  const { scheduler, stalls, watchdog } = createHarness()
  watchdog.activate(7)
  const timer = scheduler.latestId()
  watchdog.destroy()
  assert.equal(scheduler.activeCount(), 0)
  scheduler.invokeEvenIfCancelled(timer)
  assert.deepEqual(stalls, [], 'Unmount cleanup must invalidate pending callbacks.')
}

assert.match(source, /player\.addListener\(\s*['"]timeUpdate['"]/)
assert.match(source, /player\.addListener\(\s*['"]playingChange['"]/)
assert.match(source, /timeUpdateSubscription\.remove\(\)/)
assert.match(source, /playingChangeSubscription\.remove\(\)/)
assert.match(source, /videoWatchdogRef\.current\.destroy\(\)/)
assert.match(source, /activeVideoGenerationRef\.current\s*!==\s*generation/)
assert.doesNotMatch(source, /setInterval\s*\(/)

function extractArrowCallback(startMarker) {
  const markerIndex = source.indexOf(startMarker)
  assert.notEqual(markerIndex, -1, `Missing callback marker: ${startMarker}`)
  const arrowIndex = source.indexOf('() => {', markerIndex)
  const openingBrace = source.indexOf('{', arrowIndex)
  let depth = 0

  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(arrowIndex, index + 1)
  }
  throw new Error(`Unable to extract callback: ${startMarker}`)
}

const playToEndCallbackSource = extractArrowCallback(
  "player.addListener(\n      'playToEnd'"
)
const createPlayToEndCallback = Function(
  'generation',
  'activeVideoGenerationRef',
  'playlistLengthRef',
  'advanceCurrentItem',
  'videoWatchdogRef',
  `return (${playToEndCallbackSource})`
)

function exercisePlayToEnd(playlistLength, generation) {
  const watchdogCalls = []
  let advanceCalls = 0
  const callback = createPlayToEndCallback(
    generation,
    { current: generation },
    { current: playlistLength },
    () => {
      advanceCalls += 1
    },
    {
      current: {
        activate: (value) => watchdogCalls.push(['activate', value]),
        deactivate: (value) => watchdogCalls.push(['deactivate', value]),
      },
    }
  )
  callback()
  return { advanceCalls, watchdogCalls }
}

assert.deepEqual(exercisePlayToEnd(1, 30), {
  advanceCalls: 0,
  watchdogCalls: [['activate', 30]],
})
assert.deepEqual(exercisePlayToEnd(2, 31), {
  advanceCalls: 1,
  watchdogCalls: [['deactivate', 31]],
})

console.log('Media player watchdog behavior checks passed.')
