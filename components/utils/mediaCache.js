import * as FileSystem from 'expo-file-system'
import * as Crypto from 'expo-crypto'

/**
 * Módulo de caché de media para los totems.
 *
 * Diseñado para dispositivos de pocos recursos:
 * - Descarga ATÓMICA (.tmp + rename): si se corta la red a mitad, no queda un
 *   archivo corrupto que luego se reproduce como si fuera válido.
 * - Hash sobre la URL LIMPIA (sin query): URLs estables => sin duplicados.
 * - Límite LRU de caché: el almacenamiento en hardware barato es escaso.
 */

export const MediaType = {
  VIDEO: 'VIDEO',
  IMAGE: 'IMAGE',
  UNKNOWN: 'UNKNOWN',
}

export const MEDIA_CACHE_DIR = `${FileSystem.cacheDirectory}mediaCache/`

// Tope de caché en disco. Por encima de esto se borran los archivos más viejos.
const DEFAULT_MAX_CACHE_BYTES = 500 * 1024 * 1024 // 500 MB

const VIDEO_EXT = /\.(mp4|avi|mov|mkv|webm|m4v)$/
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)$/

const cleanUrl = (url) => url.split('?')[0].split('#')[0]

/**
 * Determina el tipo de media por extensión. Tolera url null/no-string para no
 * crashear, y reconoce más formatos que la versión anterior (webm, mkv, gif...).
 */
export const getMediaType = (url) => {
  if (!url || typeof url !== 'string') return MediaType.UNKNOWN
  const path = cleanUrl(url).toLowerCase()
  if (VIDEO_EXT.test(path)) return MediaType.VIDEO
  if (IMAGE_EXT.test(path)) return MediaType.IMAGE
  return MediaType.UNKNOWN
}

let cacheDirReady = null

/** Crea el directorio de caché una sola vez (idempotente). */
export const ensureCacheDir = async () => {
  if (!cacheDirReady) {
    cacheDirReady = FileSystem.makeDirectoryAsync(MEDIA_CACHE_DIR, {
      intermediates: true,
    }).catch((err) => {
      // Si ya existía no es un error real; cualquier otro caso se re-lanza.
      if (!String(err?.message || '').toLowerCase().includes('exist')) {
        cacheDirReady = null
        throw err
      }
    })
  }
  return cacheDirReady
}

/** Nombre de archivo cacheado: MD5 de la URL limpia + extensión. */
export const cachedFileName = async (url) => {
  const clean = cleanUrl(url)
  const hash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.MD5,
    clean
  )
  const dot = clean.lastIndexOf('.')
  const ext = dot >= 0 ? clean.substring(dot) : ''
  return `${hash}${ext}`
}

/**
 * Devuelve la URI LOCAL del archivo, descargándolo si hace falta.
 * Si la descarga falla, cae a la URL remota (streaming) como último recurso.
 */
export const cacheMediaFile = async (url) => {
  try {
    await ensureCacheDir()
    const fileName = await cachedFileName(url)
    const localPath = `${MEDIA_CACHE_DIR}${fileName}`

    const info = await FileSystem.getInfoAsync(localPath)
    if (info.exists && info.size > 0) {
      return localPath
    }

    // Descarga atómica: a .tmp y recién al terminar se renombra al destino.
    const tmpPath = `${localPath}.tmp`
    await FileSystem.deleteAsync(tmpPath, { idempotent: true })
    const result = await FileSystem.downloadAsync(url, tmpPath)

    if (result.status >= 200 && result.status < 300) {
      await FileSystem.moveAsync({ from: tmpPath, to: localPath })
      return localPath
    }

    // HTTP de error: limpiamos el parcial y caemos a remoto.
    await FileSystem.deleteAsync(tmpPath, { idempotent: true })
    return url
  } catch (err) {
    console.warn('[mediaCache] no se pudo cachear, uso URL remota:', err?.message)
    return url
  }
}

/** Borra de la caché lo que ya no está en la playlist (incluye .tmp huérfanos). */
export const cleanCacheForPlaylist = async (playlist) => {
  try {
    await ensureCacheDir()
    const cachedFiles = await FileSystem.readDirectoryAsync(MEDIA_CACHE_DIR)
    const validNames = new Set(
      await Promise.all(
        (playlist || [])
          .filter((item) => item?.videoUrl)
          .map((item) => cachedFileName(item.videoUrl))
      )
    )
    const toDelete = cachedFiles.filter((f) => !validNames.has(f))
    await Promise.all(
      toDelete.map((f) =>
        FileSystem.deleteAsync(`${MEDIA_CACHE_DIR}${f}`, { idempotent: true })
      )
    )
  } catch (err) {
    console.warn('[mediaCache] error al limpiar la caché:', err?.message)
  }
}

/** Aplica el tope de caché borrando los archivos menos usados (más viejos). */
export const enforceCacheLimit = async (maxBytes = DEFAULT_MAX_CACHE_BYTES) => {
  try {
    await ensureCacheDir()
    const files = await FileSystem.readDirectoryAsync(MEDIA_CACHE_DIR)
    const stats = await Promise.all(
      files.map(async (name) => {
        const info = await FileSystem.getInfoAsync(`${MEDIA_CACHE_DIR}${name}`)
        return { name, size: info.size || 0, mtime: info.modificationTime || 0 }
      })
    )
    let total = stats.reduce((acc, f) => acc + f.size, 0)
    if (total <= maxBytes) return

    // LRU: del más viejo al más nuevo hasta volver por debajo del tope.
    stats.sort((a, b) => a.mtime - b.mtime)
    for (const f of stats) {
      if (total <= maxBytes) break
      await FileSystem.deleteAsync(`${MEDIA_CACHE_DIR}${f.name}`, {
        idempotent: true,
      })
      total -= f.size
    }
  } catch (err) {
    console.warn('[mediaCache] no se pudo aplicar el límite:', err?.message)
  }
}
