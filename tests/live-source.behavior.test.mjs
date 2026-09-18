import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// The live URL is typed by a person into the dashboard and ends up in the
// native player, so what matters is that only an https address of sane length
// gets through, and that the screen always knows where to go back to.

async function loadModule() {
  const url = new URL('../components/utils/liveSource.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ Array, Object, RegExp })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })
  await module.link(() => {
    throw new Error('The live source validator must stay free of runtime dependencies.')
  })
  await module.evaluate()
  return module.namespace
}

const plain = (value) => JSON.parse(JSON.stringify(value))

const {
  DEFAULT_RETURN_SCREEN,
  LIVE_RETURN_SCREENS,
  MAX_LIVE_URL_LENGTH,
  normalizeLiveSource,
  normalizeReturnScreen,
} = await loadModule()

const streamUrl = 'https://cdn.example/live/channel.m3u8?token=abc'

assert.deepEqual(
  plain(normalizeLiveSource({ url: streamUrl, startedAt: 1, returnTo: 'Canvas' })),
  { url: streamUrl, returnTo: 'Canvas' },
  'Only the URL and the return screen matter to the player.'
)
assert.deepEqual(
  plain(normalizeLiveSource({ url: 'https://cdn.example/live/index' })),
  { url: 'https://cdn.example/live/index', returnTo: DEFAULT_RETURN_SCREEN },
  'A manifest URL without the .m3u8 suffix is still a URL; the player decides.'
)

// Every unusable value means "no broadcast", never a crash or a bad URL.
for (const notALiveSource of [
  null,
  undefined,
  'https://cdn.example/live.m3u8',
  42,
  [],
  {},
  { url: null },
  { url: '' },
  { url: 'http://cdn.example/live.m3u8' },
  { url: 'rtmp://cdn.example/live' },
  { url: 'javascript:alert(1)' },
  { url: 'https://cdn.example/live with space.m3u8' },
  { url: `https://cdn.example/${'x'.repeat(MAX_LIVE_URL_LENGTH)}` },
]) {
  assert.equal(
    normalizeLiveSource(notALiveSource),
    null,
    `Refused: ${JSON.stringify(notALiveSource)?.slice(0, 60)}`
  )
}
assert.equal(
  normalizeLiveSource({ url: `https://cdn.example/${'x'.repeat(MAX_LIVE_URL_LENGTH - 20)}` })
    ?.url.length,
  MAX_LIVE_URL_LENGTH,
  'The cap is inclusive.'
)

// The return screen is always one the navigator can resolve.
assert.deepEqual([...LIVE_RETURN_SCREENS], ['MediaPlayer', 'TimeWeather', 'Canvas', 'YoutubePlayer'])
for (const screen of LIVE_RETURN_SCREENS) {
  assert.equal(normalizeReturnScreen(screen), screen)
}
for (const invalid of [undefined, null, '', 'Live', 'Carousel', '__proto__', 7]) {
  assert.equal(
    normalizeReturnScreen(invalid),
    DEFAULT_RETURN_SCREEN,
    `An unknown return screen falls back to the player: ${String(invalid)}`
  )
}
assert.equal(
  normalizeLiveSource({ url: streamUrl, returnTo: 'Live' }).returnTo,
  DEFAULT_RETURN_SCREEN,
  'Returning to the live screen itself would loop; it is never allowed.'
)

console.log('Live source behavior checks passed.')
