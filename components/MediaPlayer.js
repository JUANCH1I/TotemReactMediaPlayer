import React, { useState, useEffect, useRef } from 'react'
import { View, StyleSheet, Text, Dimensions } from 'react-native'
import { Image } from 'expo-image'
import { getDatabase, ref, onValue } from 'firebase/database'
import { getDeviceId } from './utils/deviceId'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  useVideoPlayer,
  VideoView,
} from 'expo-video'
import { useEventListener } from 'expo'
import {
  MediaType,
  getMediaType,
  cacheMediaFile,
  cleanCacheForPlaylist,
  enforceCacheLimit,
  ensureCacheDir,
} from './utils/mediaCache'

const { width: windowWidth, height: windowHeight } = Dimensions.get('window')

const DEFAULT_IMAGE_SECONDS = 20
const FAILSAFE_ADVANCE_MS = 2000 // al fallar un item, esperamos antes de saltar
const PLAYLIST_CACHE_KEY = 'lastPlaylist' // resiliencia: última playlist conocida

export default function MediaPlayer({
  width = windowWidth,
  height = windowHeight,
  canvaMode = false,
  dropzoneIndex,
}) {
  const [playlist, setPlaylist] = useState([])
  const [playlistCanvas, setPlaylistCanvas] = useState([])
  const [currentPlaylist, setCurrentPlaylist] = useState([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentItem, setCurrentItem] = useState(null)
  const [volume, setVolume] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [deviceId, setDeviceId] = useState(null)
  const [error, setError] = useState(null)
  const [localUri, setLocalUri] = useState(null)
  const [qrUrl, setQrUrl] = useState(null)

  const imageTimeoutRef = useRef(null)
  const currentPlaylistRef = useRef([]) // length siempre actualizado para advance()
  const lastCleanedKeyRef = useRef('') // debounce de la limpieza de caché
  const prefetchedRef = useRef(new Set()) // urls ya prefetcheadas

  // Una sola instancia de reproductor de video para toda la vida del componente.
  const player = useVideoPlayer('', (p) => {
    p.audioMixingMode = 'mixWithOthers'
    p.loop = false
  })

  // Mantiene currentPlaylistRef sincronizado para que advance() nunca use un
  // length viejo (evita stale closures en timeouts y listeners).
  useEffect(() => {
    currentPlaylistRef.current = currentPlaylist
  }, [currentPlaylist])

  // Limpia la caché SOLO cuando la lista de URLs cambió de verdad (debounce):
  // antes se recalculaba el MD5 de toda la playlist en cada snapshot de Firebase.
  const maybeCleanCache = (list) => {
    const key = (list || []).map((it) => it.videoUrl).join('|')
    if (key === lastCleanedKeyRef.current) return
    lastCleanedKeyRef.current = key
    cleanCacheForPlaylist(list).then(() => enforceCacheLimit())
  }

  // Avanza al siguiente item. Usa el ref para tener el length actual siempre.
  const advance = () => {
    const len = currentPlaylistRef.current.length
    setCurrentIndex((prev) => (len > 0 ? (prev + 1) % len : 0))
  }

  // Descarga por anticipado el SIGUIENTE item mientras se reproduce el actual.
  const prefetchNext = () => {
    const list = currentPlaylistRef.current
    if (list.length < 2) return
    const next = list[(currentIndex + 1) % list.length]
    const url = next?.videoUrl
    if (!url || prefetchedRef.current.has(url)) return
    if (getMediaType(url) === MediaType.UNKNOWN) return
    prefetchedRef.current.add(url)
    cacheMediaFile(url).catch(() => prefetchedRef.current.delete(url))
  }

  // Resiliencia offline: muestra la última playlist conocida hasta que Firebase
  // responda (o si el totem arranca sin internet; los archivos siguen en caché).
  useEffect(() => {
    if (canvaMode) return
    AsyncStorage.getItem(PLAYLIST_CACHE_KEY).then((cached) => {
      if (!cached) return
      try {
        const saved = JSON.parse(cached)
        if (Array.isArray(saved) && saved.length > 0) {
          setPlaylist((prev) => (prev.length === 0 ? saved : prev))
          setIsLoading(false)
        }
      } catch (_) {}
    })
  }, [canvaMode])

  // --- Listeners de Firebase (playlist, volumen, rotación) ---
  useEffect(() => {
    let cancelled = false
    const unsubs = []

    const fetchData = async () => {
      try {
        await ensureCacheDir()
        const id = await getDeviceId()
        if (cancelled) return
        setDeviceId(id)
        const db = getDatabase()

        const playlistRef = ref(db, `devices/${id}/playlist`)
        const volumeRef = ref(db, `devices/${id}/volume`)
        const rotationRef = ref(db, `devices/${id}/rotation`)
        const playlistCanvasRef =
          canvaMode && dropzoneIndex !== undefined
            ? ref(db, `devices/${id}/playlistCanvas/${dropzoneIndex}`)
            : null

        unsubs.push(
          onValue(playlistRef, (snapshot) => {
            const data = snapshot.val()
            const list = data
              ? Object.keys(data)
                  .map((k) => data[k])
                  .filter((it) => it.videoUrl)
              : []
            setPlaylist(list)
            setIsLoading(false) // Firebase ya respondió (haya o no contenido)
            if (!canvaMode && list.length > 0) {
              // Persiste para que el totem arranque con contenido aunque no haya red.
              AsyncStorage.setItem(
                PLAYLIST_CACHE_KEY,
                JSON.stringify(list)
              ).catch(() => {})
            }
            maybeCleanCache(list)
          })
        )

        if (playlistCanvasRef) {
          unsubs.push(
            onValue(playlistCanvasRef, (snapshot) => {
              const data = snapshot.val()
              const list = data
                ? Object.keys(data)
                    .map((k) => data[k])
                    .filter((it) => it.videoUrl)
                : []
              setPlaylistCanvas(list)
              setIsLoading(false)
              maybeCleanCache(list)
            })
          )
        }

        unsubs.push(
          onValue(volumeRef, (snapshot) => {
            const v = snapshot.val()
            if (v !== null) setVolume(v / 100)
          })
        )

        unsubs.push(
          onValue(rotationRef, (snapshot) => {
            const r = snapshot.val()
            if (r !== null) setRotation(r)
          })
        )
      } catch (err) {
        console.error('Error fetching data:', err)
        if (!cancelled) {
          setError('Error al cargar los datos')
          setIsLoading(false)
        }
      }
    }

    fetchData()

    // Desuscribe TODOS los listeners con las funciones que devuelve onValue
    // (antes se usaba off() con un deviceId que solía ser null => fuga).
    return () => {
      cancelled = true
      unsubs.forEach((u) => {
        try {
          u()
        } catch (_) {}
      })
      clearTimeout(imageTimeoutRef.current)
    }
  }, [canvaMode, dropzoneIndex])

  // Al cambiar la playlist activa, reinicia el índice.
  useEffect(() => {
    setCurrentPlaylist(canvaMode ? playlistCanvas : playlist)
    setCurrentIndex(0)
  }, [canvaMode, playlist, playlistCanvas])

  // Resuelve el item actual según la lista y el índice.
  useEffect(() => {
    setCurrentItem(
      currentPlaylist.length > 0 ? currentPlaylist[currentIndex] : null
    )
  }, [currentPlaylist, currentIndex])

  // --- Carga del item actual SIEMPRE desde disco + prefetch del siguiente ---
  useEffect(() => {
    clearTimeout(imageTimeoutRef.current)

    if (!currentItem) {
      setLocalUri(null)
      return
    }

    const type = getMediaType(currentItem.videoUrl)

    // Formato no soportado: en vez de dejar la pantalla colgada para siempre,
    // saltamos al siguiente item.
    if (type === MediaType.UNKNOWN) {
      console.warn('[MediaPlayer] formato no soportado, salto:', currentItem.videoUrl)
      imageTimeoutRef.current = setTimeout(advance, 500)
      return
    }

    let active = true
    setError(null)
    setLocalUri(null)

    cacheMediaFile(currentItem.videoUrl).then((uri) => {
      if (!active) return
      setLocalUri(uri)

      if (type === MediaType.IMAGE) {
        // Usa la duración real del item si viene en la playlist; si no, 20s.
        const secs =
          currentItem.duration && currentItem.duration > 0
            ? currentItem.duration
            : DEFAULT_IMAGE_SECONDS
        clearTimeout(imageTimeoutRef.current)
        imageTimeoutRef.current = setTimeout(advance, secs * 1000)
      }
    })

    // El siguiente item se descarga en paralelo: cuando le toque ya está listo.
    prefetchNext()

    return () => {
      active = false
      clearTimeout(imageTimeoutRef.current)
    }
  }, [currentItem])

  // Conecta el archivo local al reproductor de video.
  useEffect(() => {
    if (
      localUri &&
      currentItem &&
      getMediaType(currentItem.videoUrl) === MediaType.VIDEO
    ) {
      player.replace(localUri)
    }
  }, [localUri, currentItem])

  useEffect(() => {
    player.volume = volume
  }, [volume])

  // Loop solo cuando hay un único elemento; con varios, avanzamos al terminar.
  useEffect(() => {
    player.loop = currentPlaylist.length === 1
  }, [currentPlaylist])

  // Fin de video: el evento correcto es 'playToEnd'. El status 'idle' NO sirve:
  // también se dispara al cargar un video nuevo y hacía que se saltearan.
  useEventListener(player, 'playToEnd', () => {
    if (currentPlaylistRef.current.length > 1) advance()
  })

  useEventListener(player, 'statusChange', ({ status, error: playerError }) => {
    if (status === 'readyToPlay' && !player.playing) {
      player.play()
    } else if (status === 'error') {
      console.warn('[MediaPlayer] error de reproducción:', playerError?.message)
      clearTimeout(imageTimeoutRef.current)
      imageTimeoutRef.current = setTimeout(advance, FAILSAFE_ADVANCE_MS)
    }
  })

  // QR con el deviceId para identificar el totem cuando no tiene contenido.
  useEffect(() => {
    getDeviceId().then((id) => {
      setQrUrl(
        `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(
          id
        )}`
      )
    })
  }, [])

  // Rotación por SOFTWARE (reemplaza el ADB que corrompía las TVs). En 90/270
  // se intercambian dimensiones y se centra para llenar la pantalla física.
  const rotated90 = rotation === 90 || rotation === 270
  const fsWidth = rotated90 ? height : width
  const fsHeight = rotated90 ? width : height

  const mediaStyle = canvaMode
    ? [
        styles.relative,
        { width, height },
        rotation ? { transform: [{ rotate: `${rotation}deg` }] } : null,
      ]
    : [
        styles.fullScreen,
        {
          width: fsWidth,
          height: fsHeight,
          left: (width - fsWidth) / 2,
          top: (height - fsHeight) / 2,
          transform: rotation ? [{ rotate: `${rotation}deg` }] : undefined,
        },
      ]

  const renderMedia = () => {
    if (!currentItem || !localUri) return null
    const type = getMediaType(currentItem.videoUrl)

    if (type === MediaType.VIDEO) {
      return (
        <VideoView
          style={mediaStyle}
          player={player}
          contentFit="contain"
          nativeControls={false}
        />
      )
    }
    if (type === MediaType.IMAGE) {
      return (
        <Image
          source={{ uri: localUri }}
          style={mediaStyle}
          contentFit="contain"
          cachePolicy="disk"
          onError={() => {
            console.warn('[MediaPlayer] error al cargar imagen')
            clearTimeout(imageTimeoutRef.current)
            imageTimeoutRef.current = setTimeout(advance, FAILSAFE_ADVANCE_MS)
          }}
        />
      )
    }
    return null
  }

  const renderNoContent = () => {
    if (currentItem || !deviceId) return null
    return (
      <View style={rotation ? { transform: [{ rotate: `${rotation}deg` }] } : null}>
        <Text style={styles.noContentText}>No hay contenido disponible</Text>
        <Text style={styles.noContentText}>deviceId: {deviceId}</Text>
        {qrUrl ? (
          <Image source={{ uri: qrUrl }} style={styles.qrCode} contentFit="contain" />
        ) : null}
      </View>
    )
  }

  if (error) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      {renderMedia()}
      {((isLoading && !currentItem) || (currentItem && !localUri)) && (
        <Text style={styles.loadingText}>Cargando...</Text>
      )}
      {renderNoContent()}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullScreen: {
    position: 'absolute',
  },
  relative: {
    position: 'relative',
  },
  loadingText: {
    color: 'white',
    fontSize: 18,
  },
  noContentText: {
    color: 'white',
    fontSize: 18,
  },
  errorText: {
    color: 'red',
    fontSize: 18,
  },
  qrCode: {
    width: 150,
    height: 150,
    marginTop: 10,
  },
})
