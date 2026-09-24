// The speed a video item plays at, chosen per item from the dashboard.
//
// Only a fixed set of rates is accepted: the dashboard offers exactly these,
// and a synchronized group needs every screen to agree on the same number, so
// anything else (missing, garbage, an unlisted value) collapses to 1. The
// stored duration stays the real length of the file; what changes is how much
// wall-clock time the item occupies, which is what the group schedule counts.

export const PLAYBACK_RATES = Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2])

export const DEFAULT_PLAYBACK_RATE = 1

export function normalizePlaybackRate(value) {
  return PLAYBACK_RATES.includes(value) ? value : DEFAULT_PLAYBACK_RATE
}

// How long an item of `durationMs` occupies on screen when played at `rate`.
export function effectiveDurationMs(durationMs, rate) {
  return durationMs / normalizePlaybackRate(rate)
}
