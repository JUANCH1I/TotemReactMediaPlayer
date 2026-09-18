import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// The live session runs unattended for hours. These checks drive it with a
// fake player and a fake clock through the nights that matter: a broadcast
// that keeps erroring, one that freezes while claiming to play, a totem that
// lost its own connection, and a dashboard that clears the broadcast.

// The session narrates its state machine to logcat; the lines are captured
// here so the healthy/streak transitions can be asserted.
const logs = []

async function loadModule() {
  const url = new URL('../components/utils/liveSession.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({
    Date,
    Math,
    Number,
    Promise,
    setTimeout,
    clearTimeout,
    console: { info: (line) => logs.push(line), warn() {}, error() {} },
  })
  const sources = {
    './liveRecovery': '../components/utils/liveRecovery.js',
    './mediaRecoveryPolicy': '../components/utils/mediaRecoveryPolicy.js',
  }
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })
  await module.link((specifier) => {
    if (!(specifier in sources)) throw new Error(`Unexpected import: ${specifier}`)

    const depUrl = new URL(sources[specifier], import.meta.url)
    return new vm.SourceTextModule(readFileSync(depUrl, 'utf8'), {
      context,
      identifier: depUrl.href,
    })
  })
  await module.evaluate()
  return module.namespace
}

const { LIVE_DEFERRED_RECHECK_MS, LivePhase, createLiveSession } = await loadModule()

// Values built inside the vm realm carry a foreign prototype, so structural
// comparisons go through a plain round trip like the other behaviour suites.
const plain = (value) => JSON.parse(JSON.stringify(value))

const GIVE_UP_MS = 10 * 60 * 1000

function createScheduler() {
  let now = 0
  let nextId = 1
  const scheduled = new Map()

  return {
    now: () => now,
    schedule: (callback, delay) => {
      const id = nextId
      nextId += 1
      scheduled.set(id, { callback, dueAt: now + delay })
      return id
    },
    cancel: (id) => scheduled.delete(id),
    advance: (milliseconds) => {
      const target = now + milliseconds
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, task]) => task.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt)[0]
        if (!due) break

        const [id, task] = due
        scheduled.delete(id)
        now = task.dueAt
        task.callback()
      }
      now = target
    },
    activeCount: () => scheduled.size,
  }
}

// A player that, on every replace, plays back a scripted reaction: an error,
// a frame that never advances, or a healthy stream.
function createFakePlayer(reaction) {
  const listeners = new Map()
  const calls = []
  const emit = (event, payload) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload)
  }

  return {
    playing: false,
    calls,
    emit,
    addListener(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return { remove: () => listeners.get(event).delete(listener) }
    },
    listenerCount: () =>
      [...listeners.values()].reduce((total, set) => total + set.size, 0),
    replace(source) {
      calls.push(['replace', source])
      if (source !== null) reaction(this, source)
    },
    pause() {
      this.playing = false
      calls.push(['pause'])
    },
    play() {
      this.playing = true
      calls.push(['play'])
    },
  }
}

const erroring = (player) =>
  player.emit('statusChange', { status: 'error', error: { message: 'HTTP 404' } })
const frozen = (player) => {
  player.emit('statusChange', { status: 'readyToPlay' })
  player.emit('playingChange', { isPlaying: true })
  player.emit('timeUpdate', { currentTime: 12 })
}

function createHarness(
  reaction,
  { connected = true, scheduler = createScheduler(), healthyPlayingMs } = {}
) {
  const player = createFakePlayer(reaction)
  const phases = []
  let giveUps = 0
  let isConnected = connected
  const session = createLiveSession({
    player,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    now: scheduler.now,
    isConnected: () => isConnected,
    onGiveUp: () => {
      giveUps += 1
    },
    onPhase: (phase) => phases.push(phase),
    ...(healthyPlayingMs === undefined ? {} : { healthyPlayingMs }),
    watchdogOptions: { startupGraceMs: 5000, stallThresholdMs: 3000 },
  })
  return {
    scheduler,
    player,
    session,
    phases,
    giveUps: () => giveUps,
    setConnected: (value) => {
      isConnected = value
    },
  }
}

const streamUrl = 'https://cdn.example/live/channel.m3u8'
const replaces = (player) => player.calls.filter(([call]) => call === 'replace')

{
  // Ten minutes of a broadcast that errors on every open: backoff climbs to
  // the ceiling, then the screen is handed back exactly once and left alone.
  const { scheduler, player, session, phases, giveUps } = createHarness(erroring)
  session.start(streamUrl)
  assert.deepEqual(
    plain(replaces(player)[0]),
    ['replace', { uri: streamUrl, contentType: 'hls', liveTargetOffset: 1.5 }],
    'The stream is opened explicitly as HLS.'
  )
  assert.deepEqual(phases, [LivePhase.CONNECTING, LivePhase.RETRYING])

  scheduler.advance(GIVE_UP_MS - 1)
  assert.equal(giveUps(), 0, 'Not before the limit.')
  const openings = replaces(player).length
  assert.ok(openings >= 20 && openings <= 25, `Backoff must reach the 30 s ceiling: ${openings} opens.`)

  scheduler.advance(60_000)
  assert.equal(giveUps(), 1, 'Exactly one give-up at the limit.')
  const openingsAtGiveUp = replaces(player).length
  assert.equal(scheduler.activeCount(), 0, 'Nothing left ticking after the give-up.')
  scheduler.advance(60 * 60 * 1000)
  assert.equal(giveUps(), 1, 'No second give-up, ever.')
  assert.equal(replaces(player).length, openingsAtGiveUp, 'No reopening after the give-up.')
  assert.deepEqual(
    phases.slice(1),
    [LivePhase.RETRYING],
    'The retrying overlay stays up through every reopen until a frame plays.'
  )
}

{
  // A stream that says "playing" but never advances is not healthy: the
  // failure streak is never reset and the screen is eventually given back.
  const { scheduler, session, phases, giveUps } = createHarness(frozen)
  session.start(streamUrl)
  assert.deepEqual(phases, [LivePhase.CONNECTING, LivePhase.PLAYING])
  scheduler.advance(GIVE_UP_MS + 60_000)
  assert.equal(giveUps(), 1, 'Frozen playback gives up like an error would.')
}

{
  // Real progress heals the streak: a drop after a healthy stretch starts a
  // fresh ten minutes.
  let opens = 0
  const flaky = (player) => {
    opens += 1
    if (opens % 2 === 1) {
      erroring(player)
      return
    }
    player.emit('statusChange', { status: 'readyToPlay' })
    player.emit('playingChange', { isPlaying: true })
    for (let second = 0; second <= 20; second += 1) {
      player.emit('timeUpdate', { currentTime: 100 + second })
    }
  }
  const { scheduler, player, session, giveUps } = createHarness(flaky)
  session.start(streamUrl)
  scheduler.advance(GIVE_UP_MS * 3)
  assert.equal(giveUps(), 0, 'A stream that keeps coming back healthy is never given up on.')
  // The healthy stream then freezes: the streak starts now, not at the first
  // error hours ago.
  player.emit('statusChange', { status: 'error', error: { message: 'drop' } })
  scheduler.advance(GIVE_UP_MS - 1000)
  assert.ok(giveUps() <= 1)
}

{
  // Stopping mid-backoff leaves no timer and no listener behind.
  const { scheduler, player, session } = createHarness(erroring)
  session.start(streamUrl)
  scheduler.advance(1000)
  assert.equal(scheduler.activeCount(), 1, 'A retry is pending.')
  assert.equal(player.listenerCount(), 4)
  session.stop()
  assert.equal(scheduler.activeCount(), 0)
  assert.equal(player.listenerCount(), 0)
  assert.deepEqual(player.calls.slice(-2), [['pause'], ['replace', null]])
  scheduler.advance(GIVE_UP_MS * 2)
  assert.equal(replaces(player).length, 2, 'Nothing reopens after stop (one real open, one null).')
}

{
  // Hundreds of retries never accumulate listeners.
  const { scheduler, player, session, setConnected } = createHarness(erroring)
  setConnected(false)
  session.start(streamUrl)
  let previousOpens = 0
  for (let cycle = 0; cycle < 300; cycle += 1) {
    scheduler.advance(30_000)
    assert.equal(player.listenerCount(), 4, `Listener count must stay constant (cycle ${cycle}).`)
    const opens = replaces(player).length
    assert.ok(opens > previousOpens, 'Offline, the stream keeps being retried.')
    previousOpens = opens
  }
}

{
  // The totem's own outage is not the broadcast's fault: no give-up while
  // offline, and the decision is taken once the connection is back.
  const { scheduler, session, giveUps, setConnected } = createHarness(erroring, { connected: false })
  session.start(streamUrl)
  scheduler.advance(GIVE_UP_MS * 4)
  assert.equal(giveUps(), 0, 'Never give up offline.')
  setConnected(true)
  scheduler.advance(LIVE_DEFERRED_RECHECK_MS + 30_000)
  assert.equal(giveUps(), 1, 'Once connected, the overdue give-up happens.')
}

{
  // A give-up that could not be written is asked again later, not dropped.
  const scheduler = createScheduler()
  const player = createFakePlayer(erroring)
  let giveUps = 0
  const session = createLiveSession({
    player,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    now: scheduler.now,
    onGiveUp: () => {
      giveUps += 1
      return giveUps === 1 ? Promise.reject(new Error('offline write')) : Promise.resolve()
    },
    watchdogOptions: { startupGraceMs: 5000, stallThresholdMs: 3000 },
  })
  session.start(streamUrl)
  scheduler.advance(GIVE_UP_MS + 60_000)
  assert.equal(giveUps, 1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  scheduler.advance(LIVE_DEFERRED_RECHECK_MS + 60_000)
  assert.equal(giveUps, 2, 'A failed give-up is retried, then succeeds and stops.')
  scheduler.advance(GIVE_UP_MS * 2)
  assert.equal(giveUps, 2)
}

{
  // The dashboard clears the broadcast: audio stops at once, and an empty
  // configuration is given up on after the same limit, only when connected.
  const { scheduler, player, session, phases, giveUps, setConnected } = createHarness(frozen)
  session.start(streamUrl)
  session.start(null)
  assert.deepEqual(
    player.calls.slice(-2),
    [['pause'], ['replace', null]],
    'Clearing the live node must pause the player and unload the source.'
  )
  assert.equal(phases.at(-1), LivePhase.NONE)
  assert.equal(player.listenerCount(), 4, 'Listeners are attached once, not per start.')

  setConnected(false)
  scheduler.advance(GIVE_UP_MS + LIVE_DEFERRED_RECHECK_MS)
  assert.equal(giveUps(), 0, 'Empty and offline: wait.')
  setConnected(true)
  scheduler.advance(LIVE_DEFERRED_RECHECK_MS)
  assert.equal(giveUps(), 1, 'Empty and connected past the limit: hand the screen back.')

  session.stop()
  assert.equal(player.listenerCount(), 0)
  assert.equal(scheduler.activeCount(), 0)
}

{
  // Events from a finished attempt are inert: a late error after a failure
  // must not schedule a second retry, and stop() makes every handler a no-op.
  const { scheduler, player, session } = createHarness(erroring)
  session.start(streamUrl)
  session.handleError('late native error')
  session.handleEnd()
  assert.equal(scheduler.activeCount(), 1, 'One retry, however many terminal signals arrive.')
  session.stop()
  session.handleStatus({ status: 'error', error: { message: 'after stop' } })
  session.handlePlaying({ isPlaying: true })
  session.handleProgress({ currentTime: 3 })
  assert.equal(scheduler.activeCount(), 0)
  assert.equal(session.getPhase(), null)
  assert.equal(player.calls.filter(([call]) => call === 'play').length, 0)
}

// A broadcast the test steers: it errors on open while the mode is 'error',
// and plays with a position that advances every second while it is
// 'healthy'; flipping to 'error' mid-playback drops it at the next tick.
function createControlledStream(scheduler) {
  let mode = 'error'
  let ticking = false
  let position = 0
  const tick = (player) =>
    scheduler.schedule(() => {
      if (mode !== 'healthy') {
        ticking = false
        player.emit('statusChange', { status: 'error', error: { message: 'dropped' } })
        return
      }

      position += 1
      player.emit('timeUpdate', { currentTime: position })
      tick(player)
    }, 1000)

  return {
    reaction: (player) => {
      if (mode !== 'healthy') {
        erroring(player)
        return
      }

      player.emit('statusChange', { status: 'readyToPlay' })
      player.emit('playingChange', { isPlaying: true })
      if (!ticking) {
        ticking = true
        tick(player)
      }
    },
    setMode: (next) => {
      mode = next
    },
  }
}

{
  // The give-up needs ten minutes of CONTINUOUS failure: nine minutes down,
  // two minutes up, nine minutes down is two separate outages, not one.
  const scheduler = createScheduler()
  const stream = createControlledStream(scheduler)
  const { session, phases, giveUps } = createHarness(stream.reaction, { scheduler })
  logs.length = 0
  session.start(streamUrl)
  scheduler.advance(9 * 60_000)
  assert.equal(giveUps(), 0)
  assert.equal(logs.filter((line) => line.includes('failure streak started')).length, 1)

  stream.setMode('healthy')
  scheduler.advance(2 * 60_000)
  assert.equal(phases.at(-1), LivePhase.PLAYING)
  assert.equal(
    logs.filter((line) => line.startsWith('Live stream healthy')).length,
    1,
    'One healthy line for the recovery.'
  )

  stream.setMode('error')
  scheduler.advance(9 * 60_000)
  assert.equal(giveUps(), 0, 'Two minutes of healthy playback reset the streak.')
  assert.equal(
    logs.filter((line) => line.includes('failure streak started')).length,
    2,
    'The second outage starts its own streak.'
  )
  scheduler.advance(2 * 60_000)
  assert.equal(giveUps(), 1, 'The second outage, on its own, does reach the limit.')
}

{
  // Forty-four seconds of healthy playback, then ten minutes of failure: the
  // streak starts at the drop, and gives up exactly once.
  const scheduler = createScheduler()
  const stream = createControlledStream(scheduler)
  stream.setMode('healthy')
  const { session, giveUps } = createHarness(stream.reaction, { scheduler })
  session.start(streamUrl)
  scheduler.advance(44_000)
  assert.equal(giveUps(), 0)

  stream.setMode('error')
  scheduler.advance(9 * 60_000)
  assert.equal(giveUps(), 0, 'Not yet.')
  scheduler.advance(2 * 60_000)
  assert.equal(giveUps(), 1, 'Exactly one give-up after ten minutes of continuous failure.')
  scheduler.advance(60 * 60_000)
  assert.equal(giveUps(), 1)
}

{
  // A player that never reports its position (no timeUpdate at all) is
  // trusted on isPlaying alone: playing for the window counts as healthy, so
  // a stream that keeps coming back is never given up on.
  const playingSilently = (player) => {
    player.emit('statusChange', { status: 'readyToPlay' })
    player.emit('playingChange', { isPlaying: true })
  }
  const { scheduler, player, session, giveUps } = createHarness(playingSilently, {
    healthyPlayingMs: 2000,
  })
  logs.length = 0
  session.start(streamUrl)
  scheduler.advance(3000)
  assert.equal(logs.filter((line) => line.startsWith('Live stream healthy')).length, 1)
  player.emit('statusChange', { status: 'error', error: { message: 'drop' } })
  scheduler.advance(30 * 60_000)
  assert.equal(giveUps(), 0, 'Each reopen plays again, so no streak ever lasts ten minutes.')
}

{
  // Unloading is only for a player that actually holds a source; an errored
  // or idle player is left alone so ExoPlayer does not log a phantom error.
  for (const [status, expectUnload] of [
    ['error', false],
    ['idle', false],
    ['readyToPlay', true],
    ['loading', true],
    [undefined, true],
  ]) {
    const { player, session } = createHarness(erroring)
    player.status = status
    session.start(streamUrl)
    player.calls.length = 0
    session.stop()
    assert.deepEqual(
      player.calls,
      expectUnload ? [['pause'], ['replace', null]] : [['pause']],
      `status ${String(status)}: unload ${expectUnload ? 'expected' : 'skipped'}`
    )
  }
}

console.log('Live session behavior checks passed.')
