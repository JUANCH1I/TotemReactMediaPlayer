import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The live screen is a separate path from the playlist engine; these pin the
// few things that make it safe to leave running unattended: it follows the
// dashboard, validates what it plays, rotates with the totem, recovers through
// the tested session, and leaves nothing behind when the dashboard takes the
// screen back.

const source = readFileSync(
  new URL('../components/LiveScreen.js', import.meta.url),
  'utf8'
)
const sessionSource = readFileSync(
  new URL('../components/utils/liveSession.js', import.meta.url),
  'utf8'
)

// Follows the dashboard, with an error callback on every subscription,
// released via the returned functions (never off()).
assert.match(source, /`devices\/\$\{id\}\/live`/)
assert.match(source, /`devices\/\$\{id\}\/rotation`/)
assert.match(source, /`devices\/\$\{id\}\/volume`/)
assert.match(source, /'\.info\/connected'/)
const subscriptions = (source.match(/onValue\(/g) ?? []).length
const errorCallbacks = (source.match(/\(subscriptionError\) => \{/g) ?? []).length
assert.equal(subscriptions, 4)
assert.equal(errorCallbacks, subscriptions, 'Every subscription must carry an error callback.')
assert.match(source, /unsubscribers\.forEach\(\(unsubscribe\) => unsubscribe\(\)\)/)
assert.doesNotMatch(source, /\boff\s*\(/)

// Plays only what the validator lets through, explicitly as HLS, straight
// from the network, through the tested session.
assert.match(source, /normalizeLiveSource\(snapshot\.val\(\)\)/)
assert.match(source, /createLiveSession\(\{/)
assert.match(source, /session\.start\(url\)/)
assert.match(sessionSource, /player\.replace\(\{ uri: url, contentType: 'hls', liveTargetOffset: LIVE_TARGET_OFFSET_SECONDS \}\)/)
assert.match(source, /instance\.loop = false/)
assert.doesNotMatch(source, /mediaCacheManager|playlistManifestStore|computeSchedule/)
assert.doesNotMatch(source, /setTimeout\(|setInterval\(/, 'Timers belong to the session.')

// A new broadcast with the same URL reopens the stream.
assert.match(source, /\[hasSnapshot, url, startedAt\]/)

// Rotates exactly like the player and the status screens.
assert.match(source, /normalizeAngle\(snapshot\.val\(\)\)/)
assert.match(source, /rotate: `\$\{rotationAngle\}deg`/)
assert.match(source, /rotation=\{rotation\}/)
assert.match(source, /surfaceType=\{isQuarterTurn \? 'textureView' : 'surfaceView'\}/)

// The dashboard slider drives the television during a broadcast.
assert.match(source, /createSystemVolumeController\(\{ nativeModule: SystemVolume \}\)/)
assert.match(source, /setDesiredVolume\(level\)/)
assert.match(source, /controller\.destroy\(\)/)

// Overlay copy is on screen, in Spanish.
assert.match(source, /Conectando con la transmisión…/)
assert.match(source, /Transmisión interrumpida, reintentando…/)
assert.match(source, /Sin transmisión configurada/)

// Giving the screen back: only while connected (the session checks), and only
// if the dashboard still has it on Live.
assert.match(source, /isConnected: \(\) => connectedRef\.current/)
assert.match(source, /runTransaction\(/)
assert.match(source, /current === LIVE_SCREEN_NAME \? returnTo : undefined/)
assert.doesNotMatch(source, /\bset\(ref\(/, 'A blind write could overwrite a dashboard decision.')
assert.match(sessionSource, /if \(!isConnected\(\)\)/)

// Progress is judged by the player's playing state only: the reported
// position must never feed a stall or health decision.
const recoverySource = readFileSync(
  new URL('../components/utils/liveRecovery.js', import.meta.url),
  'utf8'
)
for (const [name, text] of [
  ['LiveScreen', source],
  ['liveSession', sessionSource],
  ['liveRecovery', recoverySource],
]) {
  assert.doesNotMatch(text, /currentTime/, `${name} must not read currentTime.`)
  assert.doesNotMatch(text, /timeUpdate/, `${name} must not subscribe to timeUpdate.`)
}
assert.match(sessionSource, /watchdog\.setPlaying\(isPlaying\)/)
assert.match(sessionSource, /player\.addListener\('playingChange'/)

// Audio never outlives the broadcast: the session silences the player when
// the node is cleared and when the screen goes away.
assert.match(sessionSource, /try \{\s*\n\s*player\.pause\(\)/)
assert.match(sessionSource, /try \{\s*\n\s*player\.replace\(null\)/)
assert.ok(
  (source.match(/session(?:Ref\.current)?\.stop\(\)/g) ?? []).length >= 2,
  'The session must be stopped when the broadcast changes and on unmount.'
)

console.log('Live screen static checks passed.')
