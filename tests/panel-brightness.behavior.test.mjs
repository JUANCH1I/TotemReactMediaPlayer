import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// The dashboard dims a totem through the panel backlight when the television
// lets the app write it, and through a black veil when it does not. The cases
// that matter are a totem nobody configured (must do nothing), a television
// that takes the value, and every way the native write can fail.

const loadBrightness = async () => {
  const url = new URL('../components/utils/panelBrightness.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ console })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })

  await module.link(() => {
    throw new Error('The brightness policy must not import anything')
  })
  await module.evaluate()

  return module.namespace
}

const createFakeKiosk = (result) => {
  const calls = []

  return {
    calls,
    setBacklight: (level) => {
      calls.push(level)
      if (result instanceof Error) throw result
      return result
    },
  }
}

const {
  MAX_OVERLAY_OPACITY,
  applyPanelBrightness,
  normalizeDashboardBrightness,
  overlayOpacityFor,
} = await loadBrightness()

// --- normalizeDashboardBrightness ---

assert.equal(normalizeDashboardBrightness(0), 0)
assert.equal(normalizeDashboardBrightness(40), 40)
assert.equal(normalizeDashboardBrightness(100), 100)
assert.equal(normalizeDashboardBrightness(140), 100, 'out of range values are clamped')
assert.equal(normalizeDashboardBrightness(-20), 0)
assert.equal(normalizeDashboardBrightness(33.6), 34, 'the backlight takes whole steps')

for (const value of [undefined, null, '70', Number.NaN, Infinity, {}]) {
  assert.equal(
    normalizeDashboardBrightness(value),
    null,
    `a missing or malformed value is not a brightness (${String(value)})`,
  )
}

// --- overlayOpacityFor ---

assert.equal(overlayOpacityFor(100), 0, 'full brightness draws no veil')
assert.equal(overlayOpacityFor(0), MAX_OVERLAY_OPACITY, 'the darkest veil is the maximum')
assert.ok(MAX_OVERLAY_OPACITY < 1, 'the screen must never go fully black')
assert.equal(overlayOpacityFor(50), 0.425)
assert.equal(overlayOpacityFor(null), 0)

// --- applyPanelBrightness ---

{
  const kiosk = createFakeKiosk(true)
  assert.equal(applyPanelBrightness(kiosk, null), 0, 'no value, no veil')
  assert.deepEqual(kiosk.calls, [], 'no value must leave the backlight alone')
}

{
  const kiosk = createFakeKiosk(true)
  assert.equal(applyPanelBrightness(kiosk, 20), 0, 'the backlight took it, so no veil')
  assert.deepEqual(kiosk.calls, [20])
}

{
  const kiosk = createFakeKiosk(false)
  assert.equal(
    applyPanelBrightness(kiosk, 20),
    overlayOpacityFor(20),
    'a television without the key or the permission falls back to the veil',
  )
}

{
  const kiosk = createFakeKiosk(new Error('no such function'))
  const logged = []
  const opacity = applyPanelBrightness(kiosk, 60, (...args) => logged.push(args))
  assert.equal(opacity, overlayOpacityFor(60), 'a throwing native call falls back to the veil')
  assert.equal(logged.length, 1, 'the failure is logged once')
}

assert.equal(
  applyPanelBrightness(undefined, 30),
  overlayOpacityFor(30),
  'no native module at all falls back to the veil',
)
assert.equal(
  applyPanelBrightness({}, 30),
  overlayOpacityFor(30),
  'an older native build without setBacklight falls back to the veil',
)

console.log('Panel brightness behavior checks passed.')
