import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The live screen is a separate path from the playlist engine; these pin the
// few things that make it safe to leave running unattended: it follows the
// dashboard, validates what it plays, rotates with the totem, recovers, and
// leaves nothing behind when the dashboard takes the screen back.

const source = readFileSync(
  new URL('../components/LiveScreen.js', import.meta.url),
  'utf8'
)

// Follows the dashboard, with an error callback, released via the returned
// function (never off()).
assert.match(source, /`devices\/\$\{id\}\/live`/)
assert.match(source, /unsubscribeLive = onValue\(/)
assert.match(source, /\(subscriptionError\) => \{/)
assert.match(source, /unsubscribeLive\?\.\(\)/)
assert.match(source, /unsubscribeRotation\?\.\(\)/)
assert.doesNotMatch(source, /\boff\s*\(/)

// Plays only what the validator lets through, straight from the network.
assert.match(source, /normalizeLiveSource\(snapshot\.val\(\)\)/)
assert.match(source, /player\.replace\(url\)/)
assert.match(source, /instance\.loop = false/)
assert.doesNotMatch(source, /mediaCacheManager|playlistManifestStore|computeSchedule/)

// Rotates exactly like the player and the status screens.
assert.match(source, /`devices\/\$\{id\}\/rotation`/)
assert.match(source, /normalizeAngle\(snapshot\.val\(\)\)/)
assert.match(source, /rotate: `\$\{rotationAngle\}deg`/)
assert.match(source, /rotation=\{rotation\}/)
assert.match(source, /surfaceType=\{isQuarterTurn \? 'textureView' : 'surfaceView'\}/)

// Overlay copy is on screen, in Spanish.
assert.match(source, /Conectando con la transmisión…/)
assert.match(source, /Transmisión interrumpida, reintentando…/)
assert.match(source, /Sin transmisión configurada/)

// Recovery goes through the pure policy and gives the screen back once.
assert.match(source, /resolveLiveRecovery\(\{/)
assert.match(source, /createLiveStallWatchdog\(\{/)
assert.match(source, /LiveRecoveryAction\.GIVE_UP/)
assert.match(source, /setTimeout\(giveUp, LIVE_GIVE_UP_MS\)/)
assert.match(source, /`devices\/\$\{id\}\/currentScreen`/)
assert.match(source, /if \(gaveUpRef\.current\) return/)

// Every timer and listener is cleaned up when the attempt or the screen ends.
assert.ok(
  (source.match(/clearTimeout\(retryTimeoutRef\.current\)/g) ?? []).length >= 2,
  'The retry timer must be cleared per attempt and on unmount.'
)
assert.ok(
  (source.match(/clearTimeout\(giveUpTimeoutRef\.current\)/g) ?? []).length >= 2,
  'The give-up timer must be cleared when a source arrives and on unmount.'
)
assert.match(source, /watchdog\.stop\(\)/)
for (const subscription of [
  'statusChangeSubscription',
  'playingChangeSubscription',
  'timeUpdateSubscription',
  'playToEndSubscription',
]) {
  assert.match(source, new RegExp(`${subscription}\\.remove\\(\\)`))
}
assert.doesNotMatch(source, /setInterval\s*\(/)

console.log('Live screen static checks passed.')
