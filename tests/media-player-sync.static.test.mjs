import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Group inheritance and synchronized playback are wired into MediaPlayer by a
// few load-bearing references; this pins them so a refactor cannot quietly
// send a grouped screen back to its own playlist, back to a fixed dwell, or
// back to a relative "+1" that ignores the group.

const source = readFileSync(
  new URL('../components/MediaPlayer.js', import.meta.url),
  'utf8'
)

// The shared clock comes from the database, not from the television.
assert.match(source, /['"]\.info\/serverTimeOffset['"]/)
assert.match(source, /createServerClock\(/)

// The playlist path is resolved by the shared helper, never hand-built here,
// and the subscription follows the resolved source.
assert.match(source, /resolvePlaylistSource\(\{/)
assert.match(source, /onValue\(ref\(db, source\.path\)/)
assert.doesNotMatch(source, /`groups\/\$\{[^}]+\}\/playlist`/)
assert.match(source, /`groups\/\$\{groupId\}\/sync`/)
assert.match(source, /`devices\/\$\{id\}\/groupId`/)
assert.match(source, /groupStore\.load\(\)/)
assert.match(source, /groupStore\.save\(remoteGroupId\)/)
assert.match(source, /GROUP_STORE_TIMEOUT_MS/, 'The disk answer must be raced, not awaited unconditionally.')

// Group reads can be denied by rules; every one of them reports the path and
// degrades instead of freezing the screen.
const subscriptionErrorHandlers = (source.match(/\(subscriptionError\) => \{/g) ?? []).length
assert.ok(
  subscriptionErrorHandlers >= 3,
  `groupId, sync and playlist subscriptions must pass an error callback; found ${subscriptionErrorHandlers}.`
)
assert.match(source, /if \(source\.kind === 'group'\) setGroupId\(null\)/)

// Every move of playback goes through the transition decision.
assert.match(source, /computeSchedule\(\{/)
const transitionCalls = (source.match(/resolveTransition\(\{/g) ?? []).length
assert.ok(
  transitionCalls >= 2,
  `Both the snapshot path and the runtime path must call resolveTransition; found ${transitionCalls}.`
)
assert.match(source, /TransitionKind\.HOLD/)
assert.match(source, /TransitionCause\.RECOVERY/)
assert.match(source, /TransitionCause\.SYNC/)
assert.match(source, /TransitionCause\.SNAPSHOT/)
assert.doesNotMatch(source, /setCurrentIndex\(0\)/)
assert.doesNotMatch(
  source,
  /\(prevIndex \+ 1\) % playlistLength/,
  'The relative step must not be decided inside MediaPlayer.'
)

// A hold keeps the screen as-is and re-evaluates later; it must be released
// with the generation and on unmount.
assert.match(source, /holdTimeoutRef\.current = setTimeout\(/)
assert.ok(
  (source.match(/clearTimeout\(holdTimeoutRef\.current\)/g) ?? []).length >= 3,
  'The hold timer must be cleared on transition, on generation change and on unmount.'
)

// Videos are aligned by seeking, once per generation, and a wrong stored
// length sends the playlist back to sequential playback instead of past the
// real end.
assert.match(source, /player\.currentTime =/)
assert.match(source, /seekedGenerationRef\.current = generation/)
assert.match(source, /DURATION_MISMATCH_TOLERANCE_S/)
assert.match(source, /markScheduleUncomputable\(/)

// Images dwell for what is left of their slot, also when the cache fails.
assert.ok(
  (source.match(/armImageDwell\(\)/g) ?? []).length >= 2,
  'Both the cached and the fallback image paths must arm the dwell timer.'
)

// The fixed image dwell no longer lives here as a literal: the only 20000 left
// is the video startup grace constant.
const literalCount = (source.match(/\b20000\b/g) ?? []).length
const graceCount = (source.match(/VIDEO_STARTUP_GRACE_MS = 20000/g) ?? []).length
assert.equal(graceCount, 1)
assert.equal(
  literalCount,
  graceCount,
  'The image dwell must come from IMAGE_DURATION_MS via the schedule helpers.'
)
assert.doesNotMatch(source, /setTimeout\([\s\S]{0,120}?20000\s*\)/)

// Listeners are released through the function onValue returns, never off().
assert.doesNotMatch(source, /\boff\(/)
assert.match(source, /return \(\) => clock\.stop\(\)/)

console.log('Media player sync static checks passed.')
