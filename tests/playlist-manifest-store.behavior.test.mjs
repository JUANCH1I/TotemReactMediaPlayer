import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

class FakeFileSystem {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files))
    this.operations = []
    this.writeCalls = 0
    this.activeWrites = 0
    this.peakWrites = 0
    this.writeGate = null
    this.writeTransform = null
    this.failMoveFrom = null
  }

  async makeDirectoryAsync(path) {
    this.operations.push(['mkdir', path])
  }

  async getInfoAsync(path) {
    return this.files.has(path)
      ? { exists: true, isDirectory: false, size: this.files.get(path).length }
      : { exists: false, isDirectory: false }
  }

  async readAsStringAsync(path) {
    this.operations.push(['read', path])
    if (!this.files.has(path)) throw new Error(`Missing file: ${path}`)
    return this.files.get(path)
  }

  async writeAsStringAsync(path, contents) {
    this.operations.push(['write', path])
    this.writeCalls += 1
    this.activeWrites += 1
    this.peakWrites = Math.max(this.peakWrites, this.activeWrites)
    try {
      if (this.writeGate) await this.writeGate.promise
      this.files.set(
        path,
        this.writeTransform ? this.writeTransform(contents) : contents
      )
    } finally {
      this.activeWrites -= 1
    }
  }

  async deleteAsync(path) {
    this.operations.push(['delete', path])
    this.files.delete(path)
  }

  async moveAsync({ from, to }) {
    this.operations.push(['move', from, to])
    if (from === this.failMoveFrom) {
      this.failMoveFrom = null
      throw new Error(`Move failed: ${from}`)
    }
    if (!this.files.has(from)) throw new Error(`Missing move source: ${from}`)
    this.files.set(to, this.files.get(from))
    this.files.delete(from)
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function loadModule() {
  const moduleUrl = process.env.PLAYLIST_MANIFEST_SOURCE
    ? new URL(`file://${process.env.PLAYLIST_MANIFEST_SOURCE}`)
    : new URL('../components/utils/playlistManifestStore.js', import.meta.url)
  const source = readFileSync(
    moduleUrl,
    'utf8'
  )
  const context = vm.createContext({
    Array,
    Error,
    JSON,
    Map,
    Object,
    Promise,
    RegExp,
    String,
  })
  const fileSystemExports = { documentDirectory: '/documents/' }
  const cryptoExports = {
    CryptoDigestAlgorithm: { MD5: 'MD5' },
    digestStringAsync: async () => 'default-hash',
  }
  const module = new vm.SourceTextModule(source, { context })
  await module.link(async (specifier) => {
    const values =
      specifier.startsWith('expo-file-system') ? fileSystemExports : cryptoExports
    return new vm.SyntheticModule(
      Object.keys(values),
      function initialize() {
        for (const [name, value] of Object.entries(values)) {
          this.setExport(name, value)
        }
      },
      { context }
    )
  })
  await module.evaluate()
  return module.namespace
}

const {
  MAX_MEDIA_URL_LENGTH,
  MAX_PLAYLIST_MANIFEST_BYTES,
  MAX_PLAYLIST_ITEMS,
  PlaylistManifestStore,
  createPlaylistBootstrapCoordinator,
  sanitizePlaylist,
} = await loadModule()

const preservedUrl = 'https://cdn.example/video.MP4?token=stable#chapter'
assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      sanitizePlaylist({
        first: { videoUrl: preservedUrl, title: 'discarded', nested: {} },
        second: { videoUrl: 'http://cdn.example/image.jpg' },
      })
    )
  ),
  [
    { videoUrl: preservedUrl },
    { videoUrl: 'http://cdn.example/image.jpg' },
  ],
  'Validation must preserve cache URL identity while stripping unexpected fields.'
)
assert.deepEqual(JSON.parse(JSON.stringify(sanitizePlaylist(null))), [])
assert.deepEqual(JSON.parse(JSON.stringify(sanitizePlaylist({}))), [])

for (const malformed of [
  'not-an-object',
  { item: null },
  { item: [] },
  { item: {} },
  { item: { videoUrl: '' } },
  { item: { videoUrl: 'file:///private/video.mp4' } },
  { item: { videoUrl: `https://cdn.example/${'x'.repeat(MAX_MEDIA_URL_LENGTH)}` } },
  Object.fromEntries(
    Array.from({ length: MAX_PLAYLIST_ITEMS + 1 }, (_, index) => [
      String(index),
      { videoUrl: `https://cdn.example/${index}.mp4` },
    ])
  ),
]) {
  assert.equal(sanitizePlaylist(malformed), null)
}

const manifestPath = '/documents/playlist-manifests/hash.json'
const partPath = `${manifestPath}.part`
const backupPath = `${manifestPath}.backup`

{
  const store = new PlaylistManifestStore({
    fileSystem: new FakeFileSystem(),
    digest: async () => 'hash',
    documentDirectory: '/documents/',
  })
  assert.equal(await store.load('device|playlist'), null)
}

{
  const fileSystem = new FakeFileSystem()
  const store = new PlaylistManifestStore({
    fileSystem,
    digest: async () => 'hash',
    documentDirectory: '/documents/',
  })
  const playlist = [{ videoUrl: preservedUrl }]
  assert.equal(await store.save('device|playlist', playlist), true)
  assert.deepEqual(JSON.parse(fileSystem.files.get(manifestPath)), {
    version: 1,
    items: playlist,
  })
  assert.equal(fileSystem.files.has(partPath), false)
  assert.equal(fileSystem.files.has(backupPath), false)
  assert.deepEqual(JSON.parse(JSON.stringify(await store.load('device|playlist'))), playlist)

  const writeIndex = fileSystem.operations.findIndex(
    ([operation, path]) => operation === 'write' && path === partPath
  )
  const validationReadIndex = fileSystem.operations.findIndex(
    ([operation, path], index) =>
      index > writeIndex && operation === 'read' && path === partPath
  )
  const publishIndex = fileSystem.operations.findIndex(
    ([operation, from, to]) =>
      operation === 'move' && from === partPath && to === manifestPath
  )
  assert.ok(writeIndex < validationReadIndex && validationReadIndex < publishIndex)
}

{
  const backupItems = [{ videoUrl: 'https://cdn.example/backup.mp4' }]
  const fileSystem = new FakeFileSystem({
    [manifestPath]: '{corrupt',
    [backupPath]: JSON.stringify({ version: 1, items: backupItems }),
    [partPath]: '{orphan',
  })
  const store = new PlaylistManifestStore({
    fileSystem,
    digest: async () => 'hash',
    documentDirectory: '/documents/',
  })

  assert.deepEqual(
    JSON.parse(JSON.stringify(await store.load('device|playlist'))),
    backupItems
  )
  assert.equal(fileSystem.files.has(partPath), false)
  assert.deepEqual(JSON.parse(fileSystem.files.get(manifestPath)), {
    version: 1,
    items: backupItems,
  })
}

{
  const previousPayload = JSON.stringify({
    version: 1,
    items: [{ videoUrl: 'https://cdn.example/previous.mp4' }],
  })
  const fileSystem = new FakeFileSystem({ [manifestPath]: previousPayload })
  fileSystem.failMoveFrom = partPath
  const store = new PlaylistManifestStore({
    fileSystem,
    digest: async () => 'hash',
    documentDirectory: '/documents/',
  })

  await assert.rejects(
    store.save('device|playlist', [
      { videoUrl: 'https://cdn.example/replacement.mp4' },
    ]),
    /Move failed/
  )
  assert.equal(fileSystem.files.get(manifestPath), previousPayload)
  assert.equal(fileSystem.files.has(partPath), false)
}

{
  const previousPayload = JSON.stringify({
    version: 1,
    items: [{ videoUrl: 'https://cdn.example/previous.mp4' }],
  })
  const fileSystem = new FakeFileSystem({ [manifestPath]: previousPayload })
  fileSystem.writeTransform = () => '{truncated'
  const store = new PlaylistManifestStore({
    fileSystem,
    digest: async () => 'hash',
    documentDirectory: '/documents/',
  })

  await assert.rejects(
    store.save('device|playlist', [{ videoUrl: preservedUrl }]),
    /staging validation failed/
  )
  assert.equal(fileSystem.files.get(manifestPath), previousPayload)
  assert.equal(fileSystem.files.has(partPath), false)
  assert.equal(
    fileSystem.operations.some(
      ([operation, from]) => operation === 'move' && from === manifestPath
    ),
    false,
    'A corrupt staged manifest must never displace the published manifest.'
  )
}

{
  const invalidPayloads = [
    '{broken',
    JSON.stringify({ version: 2, items: [{ videoUrl: preservedUrl }] }),
    JSON.stringify({ version: 1, items: [{ videoUrl: 'javascript:alert(1)' }] }),
  ]
  for (const payload of invalidPayloads) {
    const store = new PlaylistManifestStore({
      fileSystem: new FakeFileSystem({ [manifestPath]: payload }),
      digest: async () => 'hash',
      documentDirectory: '/documents/',
    })
    assert.equal(await store.load('device|playlist'), null)
  }
}

{
  const oversizedPayload = 'x'.repeat(MAX_PLAYLIST_MANIFEST_BYTES + 1)
  const fileSystem = new FakeFileSystem({ [manifestPath]: oversizedPayload })
  const store = new PlaylistManifestStore({
    fileSystem,
    digest: async () => 'hash',
    documentDirectory: '/documents/',
  })
  assert.equal(await store.load('device|playlist'), null)
  assert.equal(
    fileSystem.operations.some(
      ([operation, path]) => operation === 'read' && path === manifestPath
    ),
    false,
    'Oversized manifests must be rejected before reading or parsing.'
  )
}

{
  const fileSystem = new FakeFileSystem()
  const gate = deferred()
  fileSystem.writeGate = gate
  const store = new PlaylistManifestStore({
    fileSystem,
    digest: async () => 'hash',
    documentDirectory: '/documents/',
  })
  const playlist = [{ videoUrl: preservedUrl }]
  const firstSave = store.save('device|playlist', playlist)
  const duplicateSave = store.save('device|playlist', playlist)
  assert.strictEqual(firstSave, duplicateSave)
  await new Promise(setImmediate)
  assert.equal(fileSystem.writeCalls, 1)
  gate.resolve()
  await firstSave
  assert.equal(fileSystem.peakWrites, 1)
}

{
  const fileSystem = new FakeFileSystem()
  const gate = deferred()
  fileSystem.writeGate = gate
  const store = new PlaylistManifestStore({
    fileSystem,
    digest: async (key) => key,
    documentDirectory: '/documents/',
  })
  const firstSave = store.save('first', [{ videoUrl: preservedUrl }])
  const secondSave = store.save('second', [{ videoUrl: preservedUrl }])
  await new Promise(setImmediate)
  assert.equal(fileSystem.writeCalls, 1)
  gate.resolve()
  await Promise.all([firstSave, secondSave])
  assert.equal(fileSystem.writeCalls, 2)
  assert.equal(fileSystem.peakWrites, 1, 'Different manifest keys must serialize globally.')
}

{
  const applied = []
  const coordinator = createPlaylistBootstrapCoordinator((items) =>
    applied.push(items.map((item) => item.videoUrl))
  )
  const local = [{ videoUrl: 'https://cdn.example/local.mp4' }]
  const remote = { first: { videoUrl: 'https://cdn.example/remote.mp4' } }

  assert.equal(coordinator.applyLocal(local), true)
  assert.notEqual(coordinator.applyRemote(remote), null)
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), [
    ['https://cdn.example/local.mp4'],
    ['https://cdn.example/remote.mp4'],
  ])
  assert.equal(coordinator.applyLocal(local), false)
}

{
  const applied = []
  const coordinator = createPlaylistBootstrapCoordinator((items) =>
    applied.push(items)
  )
  assert.deepEqual(JSON.parse(JSON.stringify(coordinator.applyRemote(null))), [])
  assert.equal(coordinator.applyLocal([{ videoUrl: preservedUrl }]), false)
  assert.deepEqual(
    JSON.parse(JSON.stringify(applied)),
    [[]],
    'An authoritative empty snapshot must clear stale content.'
  )
}

{
  const applied = []
  const coordinator = createPlaylistBootstrapCoordinator((items) =>
    applied.push(items)
  )
  assert.equal(coordinator.applyRemote({ item: { videoUrl: 'invalid' } }), null)
  assert.equal(coordinator.applyLocal([{ videoUrl: preservedUrl }]), true)
  coordinator.deactivate()
  assert.equal(coordinator.applyLocal([{ videoUrl: preservedUrl }]), false)
  assert.equal(coordinator.applyRemote({ item: { videoUrl: preservedUrl } }), null)
  assert.equal(applied.length, 1, 'Stale local reads and late remote callbacks must be inert.')
}

const mediaPlayerSource = readFileSync(
  new URL('../components/MediaPlayer.js', import.meta.url),
  'utf8'
)
assert.match(mediaPlayerSource, /playlistManifestStore\.load\(manifestKey\)/)
assert.match(
  mediaPlayerSource,
  /bootstrapCoordinator\.applyRemote\(\s*snapshot\.val\(\)\s*\)/
)
assert.match(
  mediaPlayerSource,
  /playlistManifestStore[\s\S]{0,80}\.save\(manifestKey, remotePlaylist\)/
)
assert.match(
  mediaPlayerSource,
  /bootstrapCoordinator\?\.applyLocal\(localPlaylist\)/
)
assert.match(mediaPlayerSource, /bootstrapCoordinator\?\.deactivate\(\)/)
assert.ok(
  mediaPlayerSource.indexOf('playlistManifestStore.load(manifestKey)') <
    mediaPlayerSource.indexOf('unsubscribe = onValue(') ||
    mediaPlayerSource.indexOf('playlistManifestStore.load(manifestKey)') <
      mediaPlayerSource.indexOf('unsubscribers.push('),
  'Local loading must start before Firebase subscription setup.'
)

console.log('Playlist manifest store behavior checks passed.')
