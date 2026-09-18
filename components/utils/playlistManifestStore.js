import * as Crypto from 'expo-crypto'
import * as FileSystem from 'expo-file-system/legacy'

// Bumped whenever the item shape changes. Older versions listed here are
// migrated on load by re-sanitizing their items (missing fields take their
// defaults); anything else is discarded. A fleet updated in place must keep
// playing from its cache, never fall back to the pairing screen.
export const PLAYLIST_MANIFEST_VERSION = 2
const MIGRATABLE_MANIFEST_VERSIONS = new Set([1, PLAYLIST_MANIFEST_VERSION])
export const MAX_PLAYLIST_ITEMS = 100
export const MAX_MEDIA_URL_LENGTH = 4096
export const MAX_VIDEO_ID_LENGTH = 256
export const MAX_PLAYLIST_MANIFEST_BYTES = 512 * 1024

const MANIFEST_DIRECTORY_NAME = 'playlist-manifests/'
const REMOTE_MEDIA_URL_PATTERN = /^https?:\/\/[^\s]+$/

// One malformed entry used to reject the whole snapshot, which froze the totem on
// stale content until somebody fixed the dashboard. Dropping the bad entries keeps
// the rest of the loop playing; a snapshot where nothing survives is still refused
// so a fully corrupt read cannot blank a screen that has working content.
function isUsableVideoId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_VIDEO_ID_LENGTH
  )
}

// Seconds, as the dashboard stores them. Zero means "unknown": the synchronized
// schedule treats such a video as uncomputable, so a bad value degrades to
// sequential playback instead of misplacing every screen in the group.
function sanitizeDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0
  }

  return value
}

export function sanitizePlaylist(value) {
  if (value === null) return []
  if (typeof value !== 'object') return null

  const items = []
  let discarded = 0
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    // Truncating past the cap keeps the bounded-memory guarantee without
    // discarding the items the screen can actually play.
    if (items.length === MAX_PLAYLIST_ITEMS) break

    const item = value[key]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      discarded += 1
      continue
    }

    const videoUrl = item.videoUrl
    if (
      typeof videoUrl !== 'string' ||
      videoUrl.length === 0 ||
      videoUrl.length > MAX_MEDIA_URL_LENGTH ||
      !REMOTE_MEDIA_URL_PATTERN.test(videoUrl)
    ) {
      discarded += 1
      continue
    }

    items.push({
      videoUrl,
      ...(isUsableVideoId(item.videoId) ? { videoId: item.videoId } : {}),
      duration: sanitizeDuration(item.duration),
    })
  }

  // An empty input is an authoritative "no content" and must still clear the
  // screen, unlike an input whose every entry turned out to be unusable.
  if (items.length === 0 && discarded > 0) return null

  return items
}

export function createPlaylistBootstrapCoordinator(applyPlaylist) {
  let active = true
  let authoritativeRemoteSeen = false

  return {
    applyLocal(value) {
      if (!active || authoritativeRemoteSeen || value === null) return false

      const playlist = sanitizePlaylist(value)
      if (playlist === null) return false
      applyPlaylist(playlist)
      return true
    },
    applyRemote(value) {
      if (!active) return null

      const playlist = sanitizePlaylist(value)
      if (playlist === null) return null
      authoritativeRemoteSeen = true
      applyPlaylist(playlist)
      return playlist
    },
    deactivate() {
      active = false
    },
  }
}

export class PlaylistManifestStore {
  constructor({
    fileSystem = FileSystem,
    digest = (value) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.MD5, value),
    documentDirectory = FileSystem.documentDirectory,
  } = {}) {
    this.fileSystem = fileSystem
    this.digest = digest
    this.directory = documentDirectory
      ? `${documentDirectory}${MANIFEST_DIRECTORY_NAME}`
      : null
    this.queue = Promise.resolve()
    this.initialized = false
    this.pendingSaves = new Map()
  }

  runExclusive(operation) {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => {})
    return result
  }

  async initializeLocked() {
    if (this.initialized || this.directory === null) return
    await this.fileSystem.makeDirectoryAsync(this.directory, {
      intermediates: true,
    })
    this.initialized = true
  }

  async getPaths(key) {
    if (this.directory === null) return null
    const hash = await this.digest(key)
    const manifestPath = `${this.directory}${hash}.json`
    return {
      manifestPath,
      temporaryPath: `${manifestPath}.part`,
      backupPath: `${manifestPath}.backup`,
    }
  }

  load(key) {
    return this.runExclusive(async () => {
      try {
        await this.initializeLocked()
        const paths = await this.getPaths(key)
        if (paths === null) return null

        await this.deleteBestEffort(paths.temporaryPath)
        const manifest = await this.readManifestLocked(paths.manifestPath)
        if (manifest !== null) {
          await this.deleteBestEffort(paths.backupPath)
          return manifest
        }

        const backupManifest = await this.readManifestLocked(paths.backupPath)
        if (backupManifest !== null) {
          await this.deleteBestEffort(paths.manifestPath)
          try {
            await this.fileSystem.moveAsync({
              from: paths.backupPath,
              to: paths.manifestPath,
            })
          } catch (_error) {
            // The backup remains readable if restoration is unavailable.
          }
        }
        return backupManifest
      } catch (_error) {
        return null
      }
    })
  }

  save(key, value) {
    const items = sanitizePlaylist(value)
    if (items === null || this.directory === null) return Promise.resolve(false)

    const payload = JSON.stringify({
      version: PLAYLIST_MANIFEST_VERSION,
      items,
    })
    const pending = this.pendingSaves.get(key)
    if (pending?.payload === payload) return pending.promise

    const promise = this.runExclusive(() => this.saveLocked(key, payload))
    this.pendingSaves.set(key, { payload, promise })
    const clearPending = () => {
      if (this.pendingSaves.get(key)?.promise === promise) {
        this.pendingSaves.delete(key)
      }
    }
    promise.then(clearPending, clearPending)
    return promise
  }

  async saveLocked(key, payload) {
    await this.initializeLocked()
    const paths = await this.getPaths(key)
    if (paths === null) return false

    let previousMoved = false
    try {
      await this.deleteBestEffort(paths.temporaryPath)
      await this.fileSystem.writeAsStringAsync(paths.temporaryPath, payload)

      const stagedItems = await this.readManifestLocked(paths.temporaryPath)
      if (
        stagedItems === null ||
        JSON.stringify({
          version: PLAYLIST_MANIFEST_VERSION,
          items: stagedItems,
        }) !== payload
      ) {
        throw new Error('Playlist manifest staging validation failed')
      }

      const currentInfo = await this.fileSystem.getInfoAsync(paths.manifestPath)
      if (currentInfo.exists) {
        await this.deleteBestEffort(paths.backupPath)
        await this.fileSystem.moveAsync({
          from: paths.manifestPath,
          to: paths.backupPath,
        })
        previousMoved = true
      }

      try {
        await this.fileSystem.moveAsync({
          from: paths.temporaryPath,
          to: paths.manifestPath,
        })
      } catch (error) {
        if (previousMoved) {
          await this.deleteBestEffort(paths.manifestPath)
          try {
            await this.fileSystem.moveAsync({
              from: paths.backupPath,
              to: paths.manifestPath,
            })
          } catch (_restoreError) {
            // A valid backup remains available for the next load attempt.
          }
        }
        throw error
      }

      await this.deleteBestEffort(paths.backupPath)
      return true
    } finally {
      await this.deleteBestEffort(paths.temporaryPath)
    }
  }

  async readManifestLocked(path) {
    try {
      const info = await this.fileSystem.getInfoAsync(path)
      if (
        !info.exists ||
        info.isDirectory ||
        typeof info.size !== 'number' ||
        info.size <= 0 ||
        info.size > MAX_PLAYLIST_MANIFEST_BYTES
      ) {
        return null
      }

      const parsed = JSON.parse(await this.fileSystem.readAsStringAsync(path))
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !MIGRATABLE_MANIFEST_VERSIONS.has(parsed.version) ||
        !Array.isArray(parsed.items)
      ) {
        return null
      }

      return sanitizePlaylist(parsed.items)
    } catch (_error) {
      return null
    }
  }

  async deleteBestEffort(path) {
    try {
      await this.fileSystem.deleteAsync(path, { idempotent: true })
    } catch (_error) {
      // Stale staging files are retried by the next serialized operation.
    }
  }
}

export default new PlaylistManifestStore()
