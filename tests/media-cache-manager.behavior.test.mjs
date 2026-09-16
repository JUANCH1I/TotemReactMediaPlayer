import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const MEBIBYTE = 1024 * 1024

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class FakeFileSystem {
  constructor({ files = {}, freeDiskBytes = Number.MAX_SAFE_INTEGER } = {}) {
    this.files = new Map(Object.entries(files))
    this.freeDiskBytes = freeDiskBytes
    this.downloadCalls = 0
    this.activeDownloads = 0
    this.peakDownloads = 0
    this.downloads = new Map()
    this.failUrls = new Set()
    this.sizes = new Map()
  }

  async makeDirectoryAsync() {}

  async readDirectoryAsync(directory) {
    return [...this.files.keys()]
      .filter((path) => path.startsWith(directory))
      .map((path) => path.slice(directory.length))
  }

  async getInfoAsync(path) {
    const file = this.files.get(path)
    return file
      ? {
          exists: true,
          uri: path,
          size: file.size,
          isDirectory: false,
          modificationTime: file.modificationTime ?? 0,
        }
      : { exists: false, uri: path, isDirectory: false }
  }

  async deleteAsync(path) {
    this.files.delete(path)
  }

  async downloadAsync(url, path) {
    this.downloadCalls += 1
    this.activeDownloads += 1
    this.peakDownloads = Math.max(this.peakDownloads, this.activeDownloads)
    const gate = this.downloads.get(url)

    try {
      if (gate) await gate.promise
      if (this.failUrls.has(url)) throw new Error(`Download failed: ${url}`)
      this.files.set(path, {
        size: this.sizes.get(url) ?? 1,
        modificationTime: 1,
      })
      return { uri: path, status: 200 }
    } finally {
      this.activeDownloads -= 1
    }
  }

  async moveAsync({ from, to }) {
    const file = this.files.get(from)
    if (!file) throw new Error(`Missing source: ${from}`)
    this.files.set(to, file)
    this.files.delete(from)
  }

  async getFreeDiskStorageAsync() {
    return this.freeDiskBytes
  }
}

async function loadManagerClass() {
  const sourceUrl = process.env.MEDIA_CACHE_MANAGER_SOURCE
    ? new URL(`file://${process.env.MEDIA_CACHE_MANAGER_SOURCE}`)
    : new URL('../components/utils/mediaCacheManager.js', import.meta.url)
  const source = readFileSync(
    sourceUrl,
    'utf8'
  )
  const context = vm.createContext({ Date, Error, Map, Promise, Set, fetch })
  const fileSystemExports = {
    cacheDirectory: '/default/',
    makeDirectoryAsync: async () => {},
    readDirectoryAsync: async () => [],
    getInfoAsync: async (path) => ({
      exists: false,
      uri: path,
      isDirectory: false,
    }),
    deleteAsync: async () => {},
    downloadAsync: async () => ({ status: 200 }),
    moveAsync: async () => {},
    getFreeDiskStorageAsync: async () => Number.MAX_SAFE_INTEGER,
  }
  const cryptoExports = {
    CryptoDigestAlgorithm: { MD5: 'MD5' },
    digestStringAsync: async () => 'default-hash',
  }
  const module = new vm.SourceTextModule(source, { context })

  await module.link(async (specifier) => {
    const values =
      specifier === 'expo-file-system' ? fileSystemExports : cryptoExports
    const dependency = new vm.SyntheticModule(
      Object.keys(values),
      function initialize() {
        for (const [name, value] of Object.entries(values)) {
          this.setExport(name, value)
        }
      },
      { context }
    )
    return dependency
  })
  await module.evaluate()
  return module.namespace.MediaCacheManager
}

function createHeadFetch(contentLengths) {
  const calls = new Map()
  const fetchImpl = async (url, options) => {
    assert.equal(options?.method, 'HEAD')
    calls.set(url, (calls.get(url) ?? 0) + 1)
    const size = contentLengths.get(url)
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(size) : null) },
    }
  }
  return { fetchImpl, calls }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(setImmediate)
  }
  throw new Error('Timed out waiting for test condition')
}

const MediaCacheManager = await loadManagerClass()

{
  const firstUrl = 'https://cdn.example/first.mp4'
  const secondUrl = 'https://cdn.example/second.mp4'
  const cachedUrl = 'https://cdn.example/cached.mp4'
  const firstGate = deferred()
  const secondGate = deferred()
  const fileSystem = new FakeFileSystem({
    files: { '/cache/cached.mp4': { size: 5, modificationTime: 1 } },
  })
  fileSystem.downloads.set(firstUrl, firstGate)
  fileSystem.downloads.set(secondUrl, secondGate)
  fileSystem.sizes.set(firstUrl, 100)
  fileSystem.sizes.set(secondUrl, 100)
  const { fetchImpl } = createHeadFetch(
    new Map([
      [firstUrl, 100],
      [secondUrl, 100],
    ])
  )
  const manager = new MediaCacheManager({
    fileSystem,
    fetchImpl,
    digest: async (url) =>
      url === firstUrl ? 'first' : url === secondUrl ? 'second' : 'cached',
    cacheDirectory: '/cache/',
    maxCacheBytes: 1000,
    minFreeDiskBytes: 0,
  })

  const [first, second] = await Promise.all([
    manager.acquire(firstUrl),
    manager.acquire(secondUrl),
  ])
  await waitFor(() => fileSystem.downloadCalls === 1)
  assert.equal(fileSystem.peakDownloads, 1)
  assert.equal(manager.reservedBytes, 100, 'Incoming capacity must be reserved during transfer.')

  const cachedLease = await manager.acquire(cachedUrl)
  assert.equal(cachedLease.isLocal, true, 'A slow transfer must not block state/lease acquisition.')
  await cachedLease.release()
  assert.equal(fileSystem.downloadCalls, 1, 'The second URL must remain queued globally.')

  firstGate.resolve()
  await first.cachePromise
  await waitFor(() => fileSystem.downloadCalls === 2)
  assert.equal(fileSystem.peakDownloads, 1)
  assert.equal(manager.reservedBytes, 100)
  secondGate.resolve()
  await second.cachePromise
  assert.equal(manager.reservedBytes, 0)
}

{
  const firstUrl = 'https://cdn.example/large-a.mp4'
  const secondUrl = 'https://cdn.example/large-b.mp4'
  const largeSize = 400 * MEBIBYTE
  const fileSystem = new FakeFileSystem()
  const { fetchImpl } = createHeadFetch(
    new Map([
      [firstUrl, largeSize],
      [secondUrl, largeSize],
    ])
  )
  const manager = new MediaCacheManager({
    fileSystem,
    fetchImpl,
    digest: async (url) => (url === firstUrl ? 'large-a' : 'large-b'),
    cacheDirectory: '/cache/',
    maxCacheBytes: 384 * MEBIBYTE,
    minFreeDiskBytes: 512 * MEBIBYTE,
  })
  const [first, second] = await Promise.all([
    manager.acquire(firstUrl),
    manager.acquire(secondUrl),
  ])

  assert.equal(await first.cachePromise, null)
  assert.equal(await second.cachePromise, null)
  assert.equal(fileSystem.downloadCalls, 0, 'Oversized transfers must never start.')
  assert.equal(manager.reservedBytes, 0)
}

{
  const url = 'https://cdn.example/shared.mp4'
  const gate = deferred()
  const fileSystem = new FakeFileSystem()
  fileSystem.downloads.set(url, gate)
  fileSystem.sizes.set(url, 20)
  const { fetchImpl, calls } = createHeadFetch(new Map([[url, 20]]))
  const manager = new MediaCacheManager({
    fileSystem,
    fetchImpl,
    digest: async () => 'shared',
    cacheDirectory: '/cache/',
    maxCacheBytes: 100,
    minFreeDiskBytes: 0,
  })
  const [first, second] = await Promise.all([
    manager.acquire(url),
    manager.acquire(url),
  ])

  assert.strictEqual(first.cachePromise, second.cachePromise)
  await waitFor(() => fileSystem.downloadCalls === 1)
  gate.resolve()
  await first.cachePromise
  assert.equal(fileSystem.downloadCalls, 1)
  assert.equal(calls.get(url), 1)
}

{
  const failingUrl = 'https://cdn.example/failing.mp4'
  const nextUrl = 'https://cdn.example/next.mp4'
  const fileSystem = new FakeFileSystem()
  fileSystem.failUrls.add(failingUrl)
  fileSystem.sizes.set(nextUrl, 25)
  const { fetchImpl } = createHeadFetch(
    new Map([
      [failingUrl, 25],
      [nextUrl, 25],
    ])
  )
  const manager = new MediaCacheManager({
    fileSystem,
    fetchImpl,
    digest: async (url) => (url === failingUrl ? 'failing' : 'next'),
    cacheDirectory: '/cache/',
    maxCacheBytes: 100,
    minFreeDiskBytes: 0,
  })

  const failing = await manager.acquire(failingUrl)
  await assert.rejects(failing.cachePromise, /Download failed/)
  await manager.runExclusive(() => {})
  assert.equal(manager.reservedBytes, 0, 'Failed transfers must release capacity.')
  assert.equal(manager.activeParts.size, 0)
  assert.equal(manager.downloads.size, 0)

  const next = await manager.acquire(nextUrl)
  assert.equal(await next.cachePromise, '/cache/next.mp4')
}

{
  const url = 'https://cdn.example/larger-than-declared.mp4'
  const fileSystem = new FakeFileSystem()
  fileSystem.sizes.set(url, 26)
  const { fetchImpl } = createHeadFetch(new Map([[url, 25]]))
  const manager = new MediaCacheManager({
    fileSystem,
    fetchImpl,
    digest: async () => 'mismatch',
    cacheDirectory: '/cache/',
    maxCacheBytes: 100,
    minFreeDiskBytes: 0,
  })

  const source = await manager.acquire(url)
  assert.equal(await source.cachePromise, null)
  assert.equal(manager.reservedBytes, 0, 'Skipped publication must release capacity.')
  assert.equal(fileSystem.files.has('/cache/mismatch.mp4'), false)
  assert.equal(fileSystem.files.has('/cache/mismatch.mp4.part'), false)
}

{
  const url = 'https://cdn.example/truncated.mp4'
  const fileSystem = new FakeFileSystem()
  fileSystem.sizes.set(url, 24)
  const { fetchImpl } = createHeadFetch(new Map([[url, 25]]))
  const manager = new MediaCacheManager({
    fileSystem,
    fetchImpl,
    digest: async () => 'truncated',
    cacheDirectory: '/cache/',
    maxCacheBytes: 100,
    minFreeDiskBytes: 0,
  })

  const source = await manager.acquire(url)
  assert.equal(await source.cachePromise, null)
  assert.equal(manager.reservedBytes, 0, 'Truncated transfers must release capacity.')
  assert.equal(fileSystem.files.has('/cache/truncated.mp4'), false)
  assert.equal(fileSystem.files.has('/cache/truncated.mp4.part'), false)
}

{
  const invalidContentLengths = [
    '1e3',
    '10.0',
    '+10',
    '0x10',
    'NaN',
    '9007199254740992',
    ' 10 ',
  ]

  for (const rawContentLength of invalidContentLengths) {
    const url = `https://cdn.example/header-${encodeURIComponent(rawContentLength)}.mp4`
    const { fetchImpl } = createHeadFetch(
      new Map([[url, rawContentLength]])
    )
    const manager = new MediaCacheManager({ fetchImpl })
    assert.equal(
      await manager.getContentLength(url),
      null,
      `Invalid Content-Length must be rejected: ${rawContentLength}`
    )
  }
}

{
  const url = 'https://cdn.example/unknown-size.mp4'
  const fileSystem = new FakeFileSystem()
  const { fetchImpl } = createHeadFetch(new Map())
  const manager = new MediaCacheManager({
    fileSystem,
    fetchImpl,
    digest: async () => 'unknown',
    cacheDirectory: '/cache/',
    maxCacheBytes: 100,
    minFreeDiskBytes: 0,
  })

  const source = await manager.acquire(url)
  assert.equal(await source.cachePromise, null)
  assert.equal(fileSystem.downloadCalls, 0)
  assert.equal(manager.reservedBytes, 0)
}

{
  const manager = new MediaCacheManager({
    fileSystem: new FakeFileSystem(),
    fetchImpl: async () => {
      throw new Error('HEAD should not run')
    },
    digest: async () => 'fragment',
    cacheDirectory: '/cache/',
  })
  const { localPath, temporaryPath } = await manager.getPaths(
    'https://cdn.example/video.MP4#chapter?token=secret'
  )

  assert.equal(localPath, '/cache/fragment.MP4')
  assert.equal(temporaryPath, '/cache/fragment.MP4.part')
  assert.equal(localPath.includes('#'), false)
}

console.log('Media cache manager behavior checks passed.')
