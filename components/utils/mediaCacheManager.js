import * as Crypto from 'expo-crypto'
import * as FileSystem from 'expo-file-system/legacy'

const MEBIBYTE = 1024 * 1024

// Keep the cache modest on low-storage TV devices while retaining several videos.
export const MAX_CACHE_BYTES = 384 * MEBIBYTE
// Preserve headroom for application updates, logs, and operating-system work files.
export const MIN_FREE_DISK_BYTES = 512 * MEBIBYTE

const DEFAULT_CACHE_DIRECTORY = `${FileSystem.cacheDirectory}mediaCache/`

export class MediaCacheManager {
  constructor({
    fileSystem = FileSystem,
    digest = (value) =>
      Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.MD5, value),
    cacheDirectory = DEFAULT_CACHE_DIRECTORY,
    now = Date.now,
    maxCacheBytes = MAX_CACHE_BYTES,
    minFreeDiskBytes = MIN_FREE_DISK_BYTES,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.fileSystem = fileSystem
    this.digest = digest
    this.cacheDirectory = cacheDirectory
    this.now = now
    this.maxCacheBytes = maxCacheBytes
    this.minFreeDiskBytes = minFreeDiskBytes
    this.fetchImpl = fetchImpl
    this.queue = Promise.resolve()
    this.transferQueue = Promise.resolve()
    this.initialized = false
    this.downloads = new Map()
    this.activeParts = new Set()
    this.reservedBytes = 0
    this.leaseCounts = new Map()
    this.accessMetadata = new Map()
  }

  acquire(remoteUrl) {
    return this.runExclusive(async () => {
      await this.initializeLocked()

      const { localPath, temporaryPath } = await this.getPaths(remoteUrl)
      const fileInfo = await this.fileSystem.getInfoAsync(localPath)

      if (fileInfo.exists && fileInfo.size > 0) {
        this.accessMetadata.set(localPath, {
          lastAccess: this.now(),
          size: fileInfo.size,
        })
        this.retainLeaseLocked(localPath)
        this.scheduleEviction()

        let released = false
        return {
          uri: localPath,
          isLocal: true,
          cachePromise: null,
          release: () => {
            if (released) return Promise.resolve()
            released = true
            return this.runExclusive(async () => {
              const releasedLastLease = this.releaseLeaseLocked(localPath)
              if (releasedLastLease) await this.evictLocked()
            })
          },
        }
      }

      if (fileInfo.exists) {
        await this.fileSystem.deleteAsync(localPath, { idempotent: true })
      }

      const cachePromise = this.startDownloadLocked(
        remoteUrl,
        localPath,
        temporaryPath
      )

      return {
        uri: remoteUrl,
        isLocal: false,
        cachePromise,
        release: () => Promise.resolve(),
      }
    })
  }

  runExclusive(operation) {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => {})
    return result
  }

  runTransferExclusive(operation) {
    const result = this.transferQueue.then(operation, operation)
    this.transferQueue = result.catch(() => {})
    return result
  }

  async initializeLocked() {
    if (this.initialized) return

    await this.fileSystem.makeDirectoryAsync(this.cacheDirectory, {
      intermediates: true,
    })

    const cachedFiles = await this.fileSystem.readDirectoryAsync(
      this.cacheDirectory
    )
    for (const fileName of cachedFiles) {
      if (!fileName.endsWith('.part')) continue

      try {
        await this.fileSystem.deleteAsync(
          `${this.cacheDirectory}${fileName}`,
          {
            idempotent: true,
          }
        )
      } catch (_error) {
        // A stale partial must never prevent playback or other cache operations.
      }
    }

    this.initialized = true
  }

  async getPaths(remoteUrl) {
    const cleanUrl = remoteUrl.split(/[?#]/, 1)[0]
    const lastSlash = cleanUrl.lastIndexOf('/')
    const lastDot = cleanUrl.lastIndexOf('.')
    const extension = lastDot > lastSlash ? cleanUrl.substring(lastDot) : ''
    const hash = await this.digest(remoteUrl)
    const localPath = `${this.cacheDirectory}${hash}${extension}`

    return { localPath, temporaryPath: `${localPath}.part` }
  }

  retainLeaseLocked(localPath) {
    this.leaseCounts.set(localPath, (this.leaseCounts.get(localPath) || 0) + 1)
  }

  releaseLeaseLocked(localPath) {
    const count = this.leaseCounts.get(localPath) || 0
    if (count <= 1) {
      this.leaseCounts.delete(localPath)
      return count === 1
    } else {
      this.leaseCounts.set(localPath, count - 1)
      return false
    }
  }

  startDownloadLocked(remoteUrl, localPath, temporaryPath) {
    const existingDownload = this.downloads.get(remoteUrl)
    if (existingDownload) return existingDownload

    const download = this.runTransferExclusive(() =>
      this.downloadAndPublish(remoteUrl, localPath, temporaryPath)
    )
    this.downloads.set(remoteUrl, download)
    return download
  }

  async downloadAndPublish(remoteUrl, localPath, temporaryPath) {
    let reservationBytes = 0

    try {
      const contentLength = await this.getContentLength(remoteUrl)
      if (contentLength === null) return null

      const canCache = await this.runExclusive(async () => {
        const capacity = await this.evictLocked(
          this.reservedBytes + contentLength
        )
        if (
          capacity.quotaSatisfied !== true ||
          capacity.reserveSatisfied !== true
        ) {
          return false
        }

        this.reservedBytes += contentLength
        reservationBytes = contentLength
        await this.fileSystem.deleteAsync(temporaryPath, { idempotent: true })
        this.activeParts.add(temporaryPath)
        return true
      })

      if (!canCache) return null

      const downloadResult = await this.fileSystem.downloadAsync(
        remoteUrl,
        temporaryPath
      )

      if (downloadResult.status < 200 || downloadResult.status >= 300) {
        throw new Error(
          `Media download failed with HTTP ${downloadResult.status}`
        )
      }

      return await this.runExclusive(async () => {
        const temporaryFileInfo = await this.fileSystem.getInfoAsync(
          temporaryPath
        )
        if (!temporaryFileInfo.exists || temporaryFileInfo.size === 0) {
          throw new Error('Media download produced an empty file')
        }
        if (temporaryFileInfo.size !== reservationBytes) return null

        await this.fileSystem.moveAsync({ from: temporaryPath, to: localPath })
        this.activeParts.delete(temporaryPath)
        this.releaseReservationLocked(reservationBytes)
        reservationBytes = 0
        this.accessMetadata.set(localPath, {
          lastAccess: this.now(),
          size: temporaryFileInfo.size,
        })
        await this.evictLocked()
        return localPath
      })
    } finally {
      await this.runExclusive(async () => {
        this.releaseReservationLocked(reservationBytes)
        reservationBytes = 0
        this.activeParts.delete(temporaryPath)
        if (this.downloads.get(remoteUrl)) this.downloads.delete(remoteUrl)
        try {
          await this.fileSystem.deleteAsync(temporaryPath, { idempotent: true })
        } catch (_error) {
          // The next initialization or download for this URL retries cleanup.
        }
      })
    }
  }

  async getContentLength(remoteUrl) {
    if (typeof this.fetchImpl !== 'function') return null

    try {
      const response = await this.fetchImpl(remoteUrl, { method: 'HEAD' })
      if (!response || response.status < 200 || response.status >= 300) {
        return null
      }

      const rawContentLength = response.headers?.get?.('content-length')
      // Require the canonical decimal representation; malformed or padded values fail closed.
      if (
        typeof rawContentLength !== 'string' ||
        !/^[0-9]+$/.test(rawContentLength)
      ) {
        return null
      }

      const contentLength = Number(rawContentLength)
      return Number.isSafeInteger(contentLength) && contentLength > 0
        ? contentLength
        : null
    } catch (_error) {
      return null
    }
  }

  releaseReservationLocked(bytes) {
    if (!bytes) return
    this.reservedBytes = Math.max(0, this.reservedBytes - bytes)
  }

  scheduleEviction() {
    this.runExclusive(() => this.evictLocked()).catch(() => {})
  }

  async evictLocked(additionalBytes = this.reservedBytes) {
    let cachedFiles
    let cacheSizeKnown = true
    try {
      cachedFiles = await this.fileSystem.readDirectoryAsync(this.cacheDirectory)
    } catch (_error) {
      cachedFiles = []
      cacheSizeKnown = false
    }

    const candidates = []
    let totalBytes = 0

    for (const fileName of cachedFiles) {
      const path = `${this.cacheDirectory}${fileName}`
      if (fileName.endsWith('.part') || this.activeParts.has(path)) continue

      let info
      try {
        info = await this.fileSystem.getInfoAsync(path)
      } catch (_error) {
        cacheSizeKnown = false
        continue
      }
      if (!info.exists || info.isDirectory) continue

      totalBytes += info.size
      if (this.leaseCounts.has(path)) continue

      const runtimeMetadata = this.accessMetadata.get(path)
      candidates.push({
        path,
        size: info.size,
        // Modification time is the deterministic restart fallback for runtime LRU.
        lastAccess:
          runtimeMetadata?.lastAccess ?? (info.modificationTime || 0) * 1000,
      })
    }

    candidates.sort(
      (left, right) =>
        left.lastAccess - right.lastAccess || left.path.localeCompare(right.path)
    )

    let freeDiskBytes = null
    try {
      freeDiskBytes = await this.fileSystem.getFreeDiskStorageAsync()
    } catch (_error) {
      // Quota enforcement remains available when the platform cannot report free space.
    }

    for (const candidate of candidates) {
      const exceedsQuota =
        totalBytes + additionalBytes > this.maxCacheBytes
      const lacksFreeSpace =
        freeDiskBytes !== null &&
        freeDiskBytes - additionalBytes < this.minFreeDiskBytes
      if (!exceedsQuota && !lacksFreeSpace) break

      try {
        await this.fileSystem.deleteAsync(candidate.path, { idempotent: true })
      } catch (_error) {
        continue
      }
      this.accessMetadata.delete(candidate.path)
      totalBytes -= candidate.size
      if (freeDiskBytes !== null) freeDiskBytes += candidate.size
    }

    if (freeDiskBytes !== null) {
      try {
        freeDiskBytes = await this.fileSystem.getFreeDiskStorageAsync()
      } catch (_error) {
        freeDiskBytes = null
      }
    }

    return {
      quotaSatisfied:
        cacheSizeKnown === false
          ? null
          : totalBytes + additionalBytes <= this.maxCacheBytes,
      reserveSatisfied:
        freeDiskBytes === null
          ? null
          : freeDiskBytes - additionalBytes >= this.minFreeDiskBytes,
    }
  }
}

export default new MediaCacheManager()
