import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Every screen in a group runs this arithmetic on its own; if two screens
// disagree on the item at a boundary, the group is visibly out of step. So the
// boundaries, the wrap-around and the "cannot know" cases are pinned here.

async function loadModule() {
  const url = new URL('../components/utils/syncSchedule.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ Array, Math, Number })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })
  await module.link(() => {
    throw new Error('The sync schedule must stay free of runtime dependencies.')
  })
  await module.evaluate()
  return module.namespace
}

const plain = (value) => JSON.parse(JSON.stringify(value))

const {
  IMAGE_DURATION_MS,
  MINIMUM_HOLD_MS,
  MINIMUM_IMAGE_DWELL_MS,
  SEEK_TOLERANCE_MS,
  ScheduleFailure,
  TransitionCause,
  TransitionKind,
  computeSchedule,
  isSameSyncConfig,
  normalizeSyncConfig,
  resolveImageDwellMs,
  resolveTransition,
  shouldSeek,
} = await loadModule()

const isImage = (item) => /\.(jpg|jpeg|png)$/i.test(item.videoUrl)
const video = (seconds) => ({ videoUrl: 'https://cdn.example/v.mp4', duration: seconds })
const image = (seconds = 0) => ({ videoUrl: 'https://cdn.example/i.jpg', duration: seconds })

assert.equal(IMAGE_DURATION_MS, 20000, 'Images keep the dwell the player always used.')

{
  // Three items: 10 s video, image (20 s by rule), 5 s video → 35 s cycle.
  const items = [video(10), image(), video(5)]
  const at = (elapsedMs) =>
    plain(computeSchedule({ items, anchorMs: 1_000_000, nowMs: 1_000_000 + elapsedMs, isImage }))

  const slot = (index, offsetMs, remainingMs) => ({
    computable: true,
    index,
    offsetMs,
    remainingMs,
    cycleMs: 35000,
  })

  assert.deepEqual(at(0), slot(0, 0, 10000))
  assert.deepEqual(at(9999), slot(0, 9999, 1))
  assert.deepEqual(at(10000), slot(1, 0, 20000), 'The exact boundary belongs to the next item.')
  assert.deepEqual(at(29999), slot(1, 19999, 1))
  assert.deepEqual(at(30000), slot(2, 0, 5000))
  assert.deepEqual(at(34999), slot(2, 4999, 1))
  assert.deepEqual(at(35000), slot(0, 0, 10000), 'A full cycle wraps back to the first item.')
  assert.deepEqual(
    at(35000 * 1000 + 12345),
    slot(1, 2345, 17655),
    'A screen joining hours later folds the elapsed time into the cycle.'
  )
  assert.deepEqual(
    at(-5000),
    slot(0, 0, 10000),
    'A clock that runs ahead of the anchor starts at the beginning, not in the past.'
  )
}

{
  // The dashboard's image duration is ignored: images always count as 20 s.
  const items = [image(3), image(999)]
  const schedule = computeSchedule({ items, anchorMs: 0, nowMs: 25000, isImage })
  assert.deepEqual(plain(schedule), {
    computable: true,
    index: 1,
    offsetMs: 5000,
    remainingMs: 15000,
    cycleMs: 2 * IMAGE_DURATION_MS,
  })
}

{
  // A single item is a cycle of its own: the offset is the elapsed modulo.
  const schedule = computeSchedule({ items: [video(8)], anchorMs: 0, nowMs: 19000, isImage })
  assert.deepEqual(plain(schedule), {
    computable: true,
    index: 0,
    offsetMs: 3000,
    remainingMs: 5000,
    cycleMs: 8000,
  })
}

{
  // Fractional durations must never push the index past the last item.
  const items = [video(0.1), video(0.2), video(0.3)]
  for (let nowMs = 0; nowMs < 5000; nowMs += 7) {
    const schedule = computeSchedule({ items, anchorMs: 0, nowMs, isImage })
    assert.ok(schedule.computable)
    assert.ok(schedule.index >= 0 && schedule.index < items.length, `index at ${nowMs}`)
    assert.ok(schedule.offsetMs >= 0, `offset at ${nowMs}`)
    assert.ok(
      schedule.remainingMs + schedule.offsetMs > 0,
      `a slot always has a positive length at ${nowMs}`
    )
  }
}

{
  // Unknowable schedules are refused rather than guessed.
  const refuse = (input) => plain(computeSchedule({ isImage, anchorMs: 0, nowMs: 1000, ...input }))

  assert.deepEqual(refuse({ items: [] }), { computable: false, reason: ScheduleFailure.EMPTY })
  assert.deepEqual(refuse({ items: null }), { computable: false, reason: ScheduleFailure.EMPTY })
  for (const badVideo of [video(0), video(-1), video(Number.NaN), video(Number.POSITIVE_INFINITY), video('10'), { videoUrl: 'https://cdn.example/v.mp4' }]) {
    assert.deepEqual(
      refuse({ items: [image(), badVideo, video(5)] }),
      { computable: false, reason: ScheduleFailure.UNKNOWN_DURATION },
      'One video of unknown length makes the whole schedule uncomputable.'
    )
  }
  for (const anchorMs of [Number.NaN, undefined, null, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(refuse({ items: [video(5)], anchorMs }), {
      computable: false,
      reason: ScheduleFailure.INVALID_ANCHOR,
    })
  }
  assert.deepEqual(refuse({ items: [video(5)], nowMs: Number.NaN }), {
    computable: false,
    reason: ScheduleFailure.INVALID_ANCHOR,
  })
}

{
  // Seeking is only worth its hiccup past the tolerance.
  assert.equal(shouldSeek(0), false)
  assert.equal(shouldSeek(SEEK_TOLERANCE_MS), false)
  assert.equal(shouldSeek(SEEK_TOLERANCE_MS + 1), true)
  assert.equal(shouldSeek(100, 50), true, 'The tolerance is adjustable')
  assert.equal(shouldSeek(Number.NaN), false)
  assert.equal(shouldSeek(undefined), false)
}

{
  // An image joined mid-way stays for what is left of its slot, never less
  // than a blink.
  assert.equal(resolveImageDwellMs(0), IMAGE_DURATION_MS)
  assert.equal(resolveImageDwellMs(5000), IMAGE_DURATION_MS - 5000)
  assert.equal(resolveImageDwellMs(IMAGE_DURATION_MS - 100), MINIMUM_IMAGE_DWELL_MS)
  assert.equal(resolveImageDwellMs(IMAGE_DURATION_MS + 5000), MINIMUM_IMAGE_DWELL_MS)
  assert.equal(resolveImageDwellMs(Number.NaN), IMAGE_DURATION_MS)
  assert.equal(resolveImageDwellMs(undefined), IMAGE_DURATION_MS)
}

{
  // Only an explicitly enabled sync with a usable anchor counts.
  assert.deepEqual(plain(normalizeSyncConfig({ enabled: true, anchor: 1700000000000 })), {
    anchorMs: 1700000000000,
  })
  for (const notSynced of [
    null,
    undefined,
    'yes',
    {},
    { enabled: false, anchor: 1 },
    { enabled: 'true', anchor: 1 },
    { enabled: true },
    { enabled: true, anchor: null },
    { enabled: true, anchor: '1700000000000' },
    { enabled: true, anchor: Number.NaN },
    { enabled: true, anchor: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(normalizeSyncConfig(notSynced), null, `Not synced: ${JSON.stringify(notSynced)}`)
  }

  assert.equal(isSameSyncConfig(null, null), true)
  assert.equal(isSameSyncConfig(null, { anchorMs: 1 }), false)
  assert.equal(isSameSyncConfig({ anchorMs: 1 }, null), false)
  assert.equal(isSameSyncConfig({ anchorMs: 1 }, { anchorMs: 1 }), true)
  assert.equal(isSameSyncConfig({ anchorMs: 1 }, { anchorMs: 2 }), false, 'A new anchor is a resync.')
}

{
  // What playback does next. Every rule here exists so that a synchronized
  // screen can never spin on the item it is already showing.
  const { END, SYNC, SNAPSHOT, RECOVERY } = TransitionCause
  const { GOTO, HOLD, RESTART } = TransitionKind
  const on = (index, offsetMs, remainingMs) => ({
    computable: true,
    index,
    offsetMs,
    remainingMs,
    cycleMs: 60000,
  })
  const decide = (input) =>
    plain(resolveTransition({ currentIndex: 1, playlistLength: 4, ...input }))

  // Sequential playback: the behaviour the player always had.
  assert.deepEqual(decide({ cause: END }), { kind: GOTO, index: 2, delayMs: 0 })
  assert.deepEqual(
    decide({ cause: END, currentIndex: 3 }),
    { kind: GOTO, index: 0, delayMs: 0 },
    'The last item wraps to the first.'
  )
  assert.deepEqual(decide({ cause: RECOVERY }), { kind: GOTO, index: 2, delayMs: 0 })
  assert.deepEqual(decide({ cause: SNAPSHOT }), { kind: GOTO, index: 0, delayMs: 0 })
  assert.deepEqual(
    decide({ cause: SYNC }),
    { kind: HOLD, index: 1, delayMs: null },
    'Sync turned off lets the current item run on.'
  )
  assert.deepEqual(
    decide({ cause: END, schedule: { computable: false, reason: 'UNKNOWN_DURATION' } }),
    { kind: GOTO, index: 2, delayMs: 0 },
    'An uncomputable schedule is sequential playback.'
  )
  assert.deepEqual(
    decide({ cause: END, playlistLength: 0 }),
    { kind: HOLD, index: 0, delayMs: null },
    'Nothing to play, nothing to schedule.'
  )

  // Normal GOTO: the group has moved to another item.
  assert.deepEqual(decide({ cause: END, schedule: on(2, 300, 9700) }), {
    kind: GOTO,
    index: 2,
    delayMs: 0,
  })
  assert.deepEqual(decide({ cause: RECOVERY, schedule: on(3, 0, 5000) }), {
    kind: GOTO,
    index: 3,
    delayMs: 0,
  })
  assert.deepEqual(
    decide({ cause: SNAPSHOT, schedule: on(1, 4000, 6000) }),
    { kind: GOTO, index: 1, delayMs: 0 },
    'A new snapshot starts where the group is even when that is the same index.'
  )

  // Stored duration longer than the file: the video ends while the group is
  // still on it. Wait out the slot on the last frame; never reload.
  assert.deepEqual(decide({ cause: END, schedule: on(1, 12000, 8000) }), {
    kind: HOLD,
    index: 1,
    delayMs: 8000,
  })
  assert.deepEqual(
    decide({ cause: END, schedule: on(1, 19999, 1) }),
    { kind: HOLD, index: 1, delayMs: MINIMUM_HOLD_MS },
    'A hold at a slot boundary still waits a moment instead of spinning.'
  )

  // Anchor in the future: everyone is pinned at item 0, offset 0, for the
  // whole first slot. Holding is the only non-spinning answer.
  assert.deepEqual(
    decide({ cause: END, currentIndex: 0, schedule: on(0, 0, 10000) }),
    { kind: HOLD, index: 0, delayMs: 10000 }
  )

  // Broken URL under sync: recovery waits at least the backoff, and at least
  // the rest of the slot, so a dead item is not refetched every two seconds.
  assert.deepEqual(decide({ cause: RECOVERY, schedule: on(1, 1000, 19000), backoffMs: 4000 }), {
    kind: HOLD,
    index: 1,
    delayMs: 19000,
  })
  assert.deepEqual(decide({ cause: RECOVERY, schedule: on(1, 19500, 500), backoffMs: 16000 }), {
    kind: HOLD,
    index: 1,
    delayMs: 16000,
  })

  // Offset refinement (a later server offset, or a re-written anchor) landing
  // on the same index: within tolerance nothing happens at all.
  assert.deepEqual(
    decide({ cause: SYNC, schedule: on(1, 5000, 15000), positionMs: 5000 + SEEK_TOLERANCE_MS }),
    { kind: HOLD, index: 1, delayMs: null }
  )
  assert.deepEqual(decide({ cause: SYNC, schedule: on(1, 5000, 15000), positionMs: 4400 }), {
    kind: HOLD,
    index: 1,
    delayMs: null,
  })
  // Visibly out of place: reload once so it can seek, then never again for
  // this item — a second misplacement waits out the slot instead.
  assert.deepEqual(decide({ cause: SYNC, schedule: on(1, 5000, 15000), positionMs: 9000 }), {
    kind: RESTART,
    index: 1,
    delayMs: 0,
  })
  assert.deepEqual(
    decide({ cause: SYNC, schedule: on(1, 5000, 15000), positionMs: null }),
    { kind: RESTART, index: 1, delayMs: 0 },
    'An unknown position cannot be trusted to be aligned.'
  )
  assert.deepEqual(
    decide({ cause: SYNC, schedule: on(1, 5000, 15000), positionMs: 9000, restartAllowed: false }),
    { kind: HOLD, index: 1, delayMs: 15000 }
  )
  assert.deepEqual(
    decide({ cause: SYNC, schedule: on(1, 5000, 15000), positionMs: 6000, tolerance: 2000 }),
    { kind: HOLD, index: 1, delayMs: null },
    'The tolerance is adjustable.'
  )
}

console.log('Sync schedule behavior checks passed.')
