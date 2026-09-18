import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// The live URL is typed by a person into the dashboard and ends up in the
// native player, so what matters is that only an https address of sane length
// gets through, and that the screen always knows where to go back to.

async function loadModule() {
  const url = new URL('../components/utils/liveSource.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ Array, Number, Object, RegExp })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })
  const allowed = {
    './screenNames': '../components/utils/screenNames.js',
    './privateNetwork': '../components/utils/privateNetwork.js',
  }
  await module.link((specifier) => {
    if (!allowed[specifier]) {
      throw new Error(`Unexpected import: ${specifier}`)
    }

    const depUrl = new URL(allowed[specifier], import.meta.url)
    return new vm.SourceTextModule(readFileSync(depUrl, 'utf8'), {
      context,
      identifier: depUrl.href,
    })
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
  plain(normalizeLiveSource({ url: streamUrl, startedAt: 1700000000000, returnTo: 'Canvas' })),
  { url: streamUrl, returnTo: 'Canvas', startedAt: 1700000000000 },
  'The URL, the return screen and the broadcast start are what the screen needs.'
)
assert.deepEqual(
  plain(normalizeLiveSource({ url: 'https://cdn.example/live/index' })),
  { url: 'https://cdn.example/live/index', returnTo: DEFAULT_RETURN_SCREEN, startedAt: null },
  'A manifest URL without the .m3u8 suffix is still a URL; the player decides.'
)
for (const startedAt of ['1700000000000', Number.NaN, null, {}]) {
  assert.equal(
    normalizeLiveSource({ url: streamUrl, startedAt }).startedAt,
    null,
    `An unusable start time is simply unknown: ${String(startedAt)}`
  )
}

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

// The return screen is always one the navigator can resolve: its allowlist
// minus the live screen itself. YoutubePlayer is not a navigator screen.
assert.deepEqual([...LIVE_RETURN_SCREENS], ['MediaPlayer', 'TimeWeather', 'Canvas', 'Carousel'])
for (const screen of LIVE_RETURN_SCREENS) {
  assert.equal(normalizeReturnScreen(screen), screen)
}
for (const invalid of [undefined, null, '', 'Live', 'YoutubePlayer', '__proto__', 7]) {
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

// Plain http is only accepted towards the venue's own private network.
assert.equal(
  normalizeLiveSource({ url: 'http://192.168.1.35:8888/pantalla/index.m3u8' })?.url,
  'http://192.168.1.35:8888/pantalla/index.m3u8'
)
assert.equal(normalizeLiveSource({ url: 'http://example.com/index.m3u8' }), null)
assert.equal(normalizeLiveSource({ url: 'http://8.8.8.8/index.m3u8' }), null)

console.log('Live source behavior checks passed.')
