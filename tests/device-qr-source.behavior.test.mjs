import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const consoleErrors = []

async function loadModule() {
  const moduleUrl = process.env.DEVICE_QR_SOURCE
    ? new URL(`file://${process.env.DEVICE_QR_SOURCE}`)
    : new URL('../components/utils/deviceQrSource.js', import.meta.url)
  const source = readFileSync(moduleUrl, 'utf8')
  const context = vm.createContext({
    Object,
    Promise,
    String,
    console: { error: (...args) => consoleErrors.push(args) },
    encodeURIComponent,
  })
  const module = new vm.SourceTextModule(source, { context })
  await module.link(() => {
    throw new Error('The QR source helper must stay free of runtime dependencies.')
  })
  await module.evaluate()
  return module.namespace
}

// Values crossing the vm realm boundary carry a foreign prototype, so structural
// comparisons go through a plain round trip like the other behaviour suites.
const plain = (value) => JSON.parse(JSON.stringify(value))

const {
  DEFAULT_QR_SIZE,
  REMOTE_QR_ENDPOINT,
  buildRemoteQrUrl,
  resolveDeviceQrSource,
} = await loadModule()

const deviceId = 'totem/01 ecuador'

{
  const url = buildRemoteQrUrl(deviceId)
  assert.ok(url.startsWith(REMOTE_QR_ENDPOINT))
  assert.ok(
    url.includes(`size=${DEFAULT_QR_SIZE}x${DEFAULT_QR_SIZE}`),
    'The remote request must carry the rendered size.'
  )
  assert.ok(
    url.includes(`data=${encodeURIComponent(deviceId)}`),
    'A device id with separators must survive the round trip intact.'
  )
  assert.equal(url.includes(' '), false, 'The URL must not carry a raw space.')
}

{
  // The whole point of the change: a totem that has never had network still gets
  // a scannable code, and the remote endpoint is never consulted.
  const calls = []
  const source = await resolveDeviceQrSource(deviceId, {
    generateLocalQr: (id, size) => {
      calls.push([id, size])
      return 'data:image/png;base64,LOCALQR'
    },
  })

  assert.deepEqual(plain(source), {
    uri: 'data:image/png;base64,LOCALQR',
    isLocal: true,
  })
  assert.deepEqual(
    calls,
    [[deviceId, DEFAULT_QR_SIZE]],
    'The generator must receive the device id and the rendered size.'
  )
}

{
  const source = await resolveDeviceQrSource(deviceId, {
    generateLocalQr: async () => 'file:///data/qr.png',
    size: 300,
  })
  assert.deepEqual(plain(source), { uri: 'file:///data/qr.png', isLocal: true })
}

{
  // No generator wired yet: today's behaviour must be unchanged.
  for (const options of [undefined, {}, { generateLocalQr: null }]) {
    const source = await resolveDeviceQrSource(deviceId, options)
    assert.deepEqual(plain(source), {
      uri: buildRemoteQrUrl(deviceId),
      isLocal: false,
    })
  }
}

{
  const before = consoleErrors.length
  const failing = [
    () => {
      throw new Error('native bridge unavailable')
    },
    async () => {
      throw new Error('native bridge rejected')
    },
  ]
  for (const generateLocalQr of failing) {
    const source = await resolveDeviceQrSource(deviceId, { generateLocalQr })
    assert.deepEqual(
      plain(source),
      { uri: buildRemoteQrUrl(deviceId), isLocal: false },
      'A generator fault must fall back instead of leaving the screen blank.'
    )
  }
  assert.equal(
    consoleErrors.length - before,
    failing.length,
    'A silent generator fault would be undiagnosable on a remote totem.'
  )
}

{
  // A generator that returns nothing usable is a fault like any other.
  for (const localUri of [null, undefined, '', 0, {}]) {
    const source = await resolveDeviceQrSource(deviceId, {
      generateLocalQr: () => localUri,
    })
    assert.deepEqual(plain(source), {
      uri: buildRemoteQrUrl(deviceId),
      isLocal: false,
    })
  }
}

{
  // Without a device id there is nothing to pair, so no QR must be claimed.
  for (const invalidId of [null, undefined, '', 42, {}]) {
    assert.equal(await resolveDeviceQrSource(invalidId), null)
  }
}

const mediaPlayerSource = readFileSync(
  new URL('../components/MediaPlayer.js', import.meta.url),
  'utf8'
)
assert.doesNotMatch(
  mediaPlayerSource,
  /api\.qrserver\.com/,
  'MediaPlayer must obtain its QR through the helper, not by building a URL.'
)
assert.match(mediaPlayerSource, /resolveDeviceQrSource\(/)
assert.match(
  mediaPlayerSource,
  /generateLocalQr: LOCAL_QR_GENERATOR/,
  'The native generator must be wireable from a single declaration.'
)

console.log('Device QR source behavior checks passed.')
