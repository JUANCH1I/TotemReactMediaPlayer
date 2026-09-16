import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sourcePath = process.env.CAROUSEL_SOURCE
  ? new URL(`file://${process.env.CAROUSEL_SOURCE}`)
  : new URL('../components/Carousel.js', import.meta.url)
const source = readFileSync(sourcePath, 'utf8')
const reducerStart = source.indexOf('function carouselReducer')
const reducerEnd = source.indexOf('\n}\n\nexport default function', reducerStart)

assert.notEqual(reducerStart, -1, 'Carousel must define one atomic playback reducer.')
assert.notEqual(reducerEnd, -1, 'Carousel reducer must be independently testable.')

const reducerSource = source.slice(reducerStart, reducerEnd + 2)
const carouselReducer = Function(`${reducerSource}; return carouselReducer`)()
const progress = {}
const original = {
  items: ['a.jpg', 'b.jpg', 'c.jpg'],
  currentIndex: 2,
  activeSlot: 0,
  revision: 4,
  progress,
}
const replacement = {
  items: ['new-a.jpg', 'new-b.jpg'],
  currentIndex: 0,
  activeSlot: 0,
  revision: 5,
  progress: {},
}

const replaced = carouselReducer(original, { type: 'replace', state: replacement })
assert.strictEqual(replaced, replacement, 'Playlist and index must be replaced atomically.')
assert.equal(replaced.items[replaced.currentIndex], 'new-a.jpg')
assert.strictEqual(
  carouselReducer(replaced, { type: 'advance', revision: 4 }),
  replaced,
  'A late animation callback must not advance a replacement playlist.',
)

let state = {
  items: ['a.jpg', 'b.jpg', 'c.jpg'],
  currentIndex: 0,
  activeSlot: 0,
  revision: 8,
  progress,
}

state = carouselReducer(state, { type: 'advance', revision: 8 })
assert.equal(state.items[state.currentIndex], 'b.jpg')
assert.equal(state.activeSlot, 1)
state = carouselReducer(state, { type: 'advance', revision: 8 })
assert.equal(state.items[state.currentIndex], 'c.jpg')
assert.equal(state.activeSlot, 0)
state = carouselReducer(state, { type: 'advance', revision: 8 })
assert.equal(state.items[state.currentIndex], 'a.jpg')
assert.equal(state.activeSlot, 1)

console.log('Carousel state behavior checks passed.')
