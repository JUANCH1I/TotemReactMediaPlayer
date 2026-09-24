// Synchronized playback across the screens of a group.
//
// Instead of each screen stepping "+1" on its own, every member derives which
// item is due and how far into it we are from one shared clock: the dashboard
// stores the server time at which the cycle started at item 0 (the anchor), and
// each screen folds the elapsed time back into the cycle. Screens never talk to
// each other; agreeing on the clock is enough for them to agree on the item.

// Images have no intrinsic length, so the schedule counts them as the same
// dwell the player has always used, whatever the dashboard stored as duration.
export const IMAGE_DURATION_MS = 20000
// A seek is a visible hiccup, so small drift is left alone rather than chased.
export const SEEK_TOLERANCE_MS = 750
// An image that is nearly over is still shown briefly instead of being skipped,
// otherwise a screen joining late would flash straight to the next item.
export const MINIMUM_IMAGE_DWELL_MS = 250
// A hold that re-evaluates immediately would spin; rounding at a slot boundary
// is absorbed by waiting at least this long.
export const MINIMUM_HOLD_MS = 250

export const ScheduleFailure = {
  EMPTY: 'EMPTY',
  INVALID_ANCHOR: 'INVALID_ANCHOR',
  UNKNOWN_DURATION: 'UNKNOWN_DURATION',
}

// `sync` as the dashboard writes it under groups/{groupId}/sync. Anything that
// is not explicitly enabled with a usable anchor means "not synchronized".
export function normalizeSyncConfig(value) {
  if (!value || typeof value !== 'object') return null
  if (value.enabled !== true) return null
  if (typeof value.anchor !== 'number' || !Number.isFinite(value.anchor)) {
    return null
  }

  return { anchorMs: value.anchor }
}

export function isSameSyncConfig(left, right) {
  if (left === null || right === null) return left === right

  return left.anchorMs === right.anchorMs
}

// A video played faster or slower occupies less or more of the cycle than its
// file length. The rate arrives already validated by the playlist sanitizer
// (see utils/playbackRate.js); this module stays dependency free, so it only
// guards against a value that could not be divided by.
function resolveItemRate(item) {
  const rate = item?.playbackRate
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1
}

function resolveItemDurationMs(item, isImage) {
  if (isImage(item)) return IMAGE_DURATION_MS

  const seconds = item?.duration
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return null
  }

  return (seconds * 1000) / resolveItemRate(item)
}

export function computeSchedule({ items, anchorMs, nowMs, isImage }) {
  if (!Array.isArray(items) || items.length === 0) {
    return { computable: false, reason: ScheduleFailure.EMPTY }
  }
  if (!Number.isFinite(anchorMs) || !Number.isFinite(nowMs)) {
    return { computable: false, reason: ScheduleFailure.INVALID_ANCHOR }
  }

  const durations = []
  let cycleMs = 0
  for (const item of items) {
    const durationMs = resolveItemDurationMs(item, isImage)
    // One video of unknown length makes every later position unknowable, so
    // the whole schedule is refused rather than guessed.
    if (durationMs === null) {
      return { computable: false, reason: ScheduleFailure.UNKNOWN_DURATION }
    }

    durations.push(durationMs)
    cycleMs += durationMs
  }

  // A screen whose clock runs ahead of the anchor is simply at the start.
  const elapsedMs = Math.max(0, nowMs - anchorMs) % cycleMs

  let index = 0
  let offsetMs = elapsedMs
  // The last item absorbs any rounding left over from the modulo, so the index
  // can never run past the end of the list.
  while (index < durations.length - 1 && offsetMs >= durations[index]) {
    offsetMs -= durations[index]
    index += 1
  }

  return {
    computable: true,
    index,
    offsetMs,
    remainingMs: durations[index] - offsetMs,
    cycleMs,
  }
}

export const TransitionKind = {
  // Move to another item (or to the first item of a new snapshot).
  GOTO: 'GOTO',
  // Keep showing what is on screen as-is (last frame, image, or error) and
  // re-evaluate after `delayMs`; `null` means the next event will do it.
  HOLD: 'HOLD',
  // Reload the current item so it can re-align; the caller bounds how often.
  RESTART: 'RESTART',
}

export const TransitionCause = {
  END: 'END',
  SYNC: 'SYNC',
  SNAPSHOT: 'SNAPSHOT',
  RECOVERY: 'RECOVERY',
}

// What playback does next. The rules exist to make the synchronized mode
// unable to spin: whenever the schedule points at the item already showing,
// the screen waits out the slot instead of reloading the item, and a failed
// item waits at least its recovery backoff. Only a sync change that finds the
// item visibly out of place asks for a reload, and the caller allows that at
// most once per item.
export function resolveTransition({
  schedule = null,
  currentIndex,
  playlistLength,
  cause,
  positionMs = null,
  backoffMs = 0,
  restartAllowed = true,
  tolerance = SEEK_TOLERANCE_MS,
}) {
  const goto = (index) => ({ kind: TransitionKind.GOTO, index, delayMs: 0 })
  const hold = (delayMs) => ({
    kind: TransitionKind.HOLD,
    index: currentIndex,
    delayMs: delayMs === null ? null : Math.max(MINIMUM_HOLD_MS, delayMs),
  })

  if (!Number.isFinite(playlistLength) || playlistLength <= 0) {
    return { kind: TransitionKind.HOLD, index: 0, delayMs: null }
  }

  // Sequential playback: the behaviour the player always had.
  if (schedule === null || !schedule.computable) {
    if (cause === TransitionCause.SNAPSHOT) return goto(0)
    if (cause === TransitionCause.SYNC) return hold(null)
    return goto((currentIndex + 1) % playlistLength)
  }

  if (schedule.index !== currentIndex || cause === TransitionCause.SNAPSHOT) {
    return goto(schedule.index)
  }

  // The group is still on this item.
  if (cause === TransitionCause.RECOVERY) {
    return hold(Math.max(schedule.remainingMs, backoffMs))
  }
  if (cause === TransitionCause.END) return hold(schedule.remainingMs)

  // A sync change: the item is right, so only a visible misplacement matters.
  const aligned =
    Number.isFinite(positionMs) &&
    Math.abs(positionMs - schedule.offsetMs) <= tolerance
  if (aligned) return hold(null)
  if (!restartAllowed) return hold(schedule.remainingMs)

  return { kind: TransitionKind.RESTART, index: currentIndex, delayMs: 0 }
}

// Wall-clock offset inside a video slot → position in the file, in ms.
export function mediaPositionMs(offsetMs, item) {
  return offsetMs * resolveItemRate(item)
}

export function shouldSeek(offsetMs, tolerance = SEEK_TOLERANCE_MS) {
  return Number.isFinite(offsetMs) && offsetMs > tolerance
}

export function resolveImageDwellMs(
  offsetMs,
  { durationMs = IMAGE_DURATION_MS, minimumMs = MINIMUM_IMAGE_DWELL_MS } = {}
) {
  const remaining = Number.isFinite(offsetMs) ? durationMs - offsetMs : durationMs

  return Math.max(minimumMs, remaining)
}
