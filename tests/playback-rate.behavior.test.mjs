import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Every screen in a group and the dashboard must agree on which speeds exist
// and on what an unlisted value means, or a single item drifts the whole cycle.

async function loadModule() {
  const url = new URL('../components/utils/playbackRate.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ Object })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })
  await module.link(() => {
    throw new Error('The playback rate helper must stay free of runtime dependencies.')
  })
  await module.evaluate()
  return module.namespace
}

const { PLAYBACK_RATES, DEFAULT_PLAYBACK_RATE, normalizePlaybackRate, effectiveDurationMs } =
  await loadModule()

assert.deepEqual([...PLAYBACK_RATES], [0.5, 0.75, 1, 1.25, 1.5, 2])
assert.equal(DEFAULT_PLAYBACK_RATE, 1)
assert.ok(Object.isFrozen(PLAYBACK_RATES), 'The set of rates is a contract, not a mutable list.')

for (const rate of PLAYBACK_RATES) {
  assert.equal(normalizePlaybackRate(rate), rate)
}
for (const junk of [undefined, null, 0, -1, 3, 1.1, '1.5', Number.NaN, Number.POSITIVE_INFINITY, {}, true]) {
  assert.equal(normalizePlaybackRate(junk), 1, `${String(junk)} must collapse to normal speed`)
}

assert.equal(effectiveDurationMs(10000, 2), 5000, 'Twice as fast takes half the time.')
assert.equal(effectiveDurationMs(10000, 0.5), 20000, 'Half speed takes twice the time.')
assert.equal(effectiveDurationMs(10000, undefined), 10000)
assert.equal(effectiveDurationMs(10000, 7), 10000, 'An unlisted rate is normal speed.')

console.log('Playback rate helper checks passed.')
