import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sourcePath = process.env.APP_NAVIGATOR_SOURCE
  ? new URL(`file://${process.env.APP_NAVIGATOR_SOURCE}`)
  : new URL('../components/AppNavigator.js', import.meta.url)
const source = readFileSync(sourcePath, 'utf8')

assert.doesNotMatch(source, /import\s+YouTubePlayer\b/)
assert.doesNotMatch(source, /case\s+['"]YoutubePlayer['"]/)
assert.doesNotMatch(source, /\boff\s*\(/)
assert.doesNotMatch(source, /\boff\b[^\n]*from\s+['"]firebase\/database['"]/)

const resolverStart = source.indexOf('function resolveScreenComponent')
const resolverEnd = source.indexOf('\n}\n\nconst AppNavigator', resolverStart)
assert.notEqual(resolverStart, -1, 'Navigator must define an allowlisted screen resolver.')
assert.notEqual(resolverEnd, -1, 'Screen resolver must remain independently testable.')

const resolverSource = source.slice(resolverStart, resolverEnd + 2)
const resolveScreenComponent = Function(
  `${resolverSource}; return resolveScreenComponent`
)()
const fallback = Symbol('MediaPlayer')
const screens = Object.freeze({
  MediaPlayer: fallback,
  TimeWeather: Symbol('TimeWeather'),
  Canvas: Symbol('Canvas'),
  Carousel: Symbol('Carousel'),
})

for (const [screenName, component] of Object.entries(screens)) {
  assert.strictEqual(
    resolveScreenComponent(screenName, screens),
    component,
    `Allowlisted screen must resolve: ${screenName}`
  )
}
for (const unsupportedName of [
  'YoutubePlayer',
  'UnknownScreen',
  '',
  null,
  undefined,
  '__proto__',
]) {
  assert.strictEqual(
    resolveScreenComponent(unsupportedName, screens),
    fallback,
    `Unsupported screen must fall back safely: ${String(unsupportedName)}`
  )
}

assert.match(source, /let\s+unsubscribe\s*=\s*null/)
assert.match(source, /unsubscribe\s*=\s*onValue\(/)
assert.match(source, /isMounted\s*=\s*false[\s\S]*unsubscribe\?\.\(\)/)
const deviceIdAwaitIndex = source.indexOf('await getDeviceId()')
const setupGuardIndex = source.indexOf('if (!isMounted) return', deviceIdAwaitIndex)
const databaseSetupIndex = source.indexOf('getDatabase()', deviceIdAwaitIndex)
assert.ok(
  deviceIdAwaitIndex < setupGuardIndex && setupGuardIndex < databaseSetupIndex,
  'Unmount must prevent Firebase setup after asynchronous device ID resolution.'
)
const listenerIndex = source.indexOf('unsubscribe = onValue(')
const callbackGuardIndex = source.indexOf('if (!isMounted) return', listenerIndex)
assert.ok(
  listenerIndex < callbackGuardIndex,
  'Late Firebase callbacks must not update an unmounted navigator.'
)
assert.equal(
  (source.match(/getDeviceId\(\)/g) ?? []).length,
  1,
  'Cleanup must not recompute the device ID.'
)

console.log('App navigator behavior checks passed.')
