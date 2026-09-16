import React, { useState, useEffect, useRef, useCallback } from 'react'
import { View, StyleSheet, Image, Text, Dimensions } from 'react-native'
import { getDatabase, ref, onValue } from 'firebase/database'
import { getDeviceId } from './utils/deviceId'
import { isPortrait } from './utils/portrait'
import mediaCacheManager from './utils/mediaCacheManager'
import playlistManifestStore, {
  createPlaylistBootstrapCoordinator,
  sanitizePlaylist,
} from './utils/playlistManifestStore'
import {
  isPictureInPictureSupported,
  useVideoPlayer,
  VideoView,
} from 'expo-video'

const { width: windowWidth, height: windowHeight } = Dimensions.get('window')

const MediaType = {
  VIDEO: 'VIDEO',
  IMAGE: 'IMAGE',
  UNKNOWN: 'UNKNOWN',
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mov'])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.png', '.jpeg'])
const MEDIA_ERROR_DISPLAY_MS = 2000
const VIDEO_STARTUP_GRACE_MS = 20000
const VIDEO_STALL_THRESHOLD_MS = 12000
const VIDEO_MINIMUM_PROGRESS_SECONDS = 0.25

function claimPlaybackTransition(
  generation,
  activeGenerationRef,
  transitionHandledGenerationRef
) {
  if (
    activeGenerationRef.current !== generation ||
    transitionHandledGenerationRef.current === generation
  ) {
    return false
  }

  transitionHandledGenerationRef.current = generation
  return true
}

function createVideoStallWatchdog({
  onStall,
  schedule = setTimeout,
  cancel = clearTimeout,
  startupGraceMs = VIDEO_STARTUP_GRACE_MS,
  stallThresholdMs = VIDEO_STALL_THRESHOLD_MS,
  minimumProgressSeconds = VIDEO_MINIMUM_PROGRESS_SECONDS,
}) {
  let activeGeneration = null
  let lastPlaybackTime = 0
  let timeout = null
  let stallHandled = false

  const clearTimer = () => {
    if (timeout === null) return
    cancel(timeout)
    timeout = null
  }

  const arm = (generation, delay) => {
    if (activeGeneration !== generation || stallHandled) return

    clearTimer()
    timeout = schedule(() => {
      timeout = null
      if (activeGeneration !== generation || stallHandled) return

      stallHandled = true
      onStall(generation)
    }, delay)
  }

  return {
    activate(generation) {
      clearTimer()
      activeGeneration = generation
      lastPlaybackTime = 0
      stallHandled = false
      arm(generation, startupGraceMs)
    },
    allowGrace(generation) {
      arm(generation, startupGraceMs)
    },
    recordProgress(generation, currentTime) {
      if (
        activeGeneration !== generation ||
        stallHandled ||
        !Number.isFinite(currentTime) ||
        Math.abs(currentTime - lastPlaybackTime) < minimumProgressSeconds
      ) {
        return
      }

      lastPlaybackTime = currentTime
      arm(generation, stallThresholdMs)
    },
    deactivate(generation) {
      if (activeGeneration !== generation) return

      activeGeneration = null
      stallHandled = false
      clearTimer()
    },
    destroy() {
      activeGeneration = null
      stallHandled = false
      clearTimer()
    },
  }
}

export default function MediaPlayer({
  width = windowWidth,
  height = windowHeight,
  canvaMode = false,
  dropzoneIndex, // Prop para canvas
}) {
  const [playlist, setPlaylist] = useState([])
  const [playlistCanvas, setPlaylistCanvas] = useState([])
  const [currentPlaylist, setCurrentPlaylist] = useState([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentItem, setCurrentItem] = useState(null)
  const [isImage, setIsImage] = useState(false)
  const [volume, setVolume] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [deviceId, setDeviceId] = useState(null)
  const [error, setError] = useState(null)
  const [localUri, setLocalUri] = useState(null)
  const [sourceGeneration, setSourceGeneration] = useState(null)
  const [qrUrl, setQrUrl] = useState(null)
  const imageTimeoutRef = useRef(null)
  const recoveryTimeoutRef = useRef(null)
  const generationCounterRef = useRef(0)
  const activeGenerationRef = useRef(null)
  const transitionHandledGenerationRef = useRef(null)
  const currentMediaTypeRef = useRef(MediaType.UNKNOWN)
  const activeVideoGenerationRef = useRef(null)
  const watchdogFailureHandlerRef = useRef(null)
  const videoWatchdogRef = useRef(null)
  if (videoWatchdogRef.current === null) {
    videoWatchdogRef.current = createVideoStallWatchdog({
      onStall: (generation) =>
        watchdogFailureHandlerRef.current?.(generation),
    })
  }
  const playlistLengthRef = useRef(currentPlaylist.length)
  playlistLengthRef.current = currentPlaylist.length

  // Configura los listeners de Firebase para playlist, volumen y rotación
  useEffect(() => {
    let isMounted = true
    const unsubscribers = []
    let bootstrapCoordinator = null
    let localPlaylistPromise = null

    const fetchData = async () => {
      try {
        const id = await getDeviceId()
        if (!isMounted) return

        setDeviceId(id)
        const manifestKey = canvaMode
          ? `${id}|playlistCanvas|${dropzoneIndex}`
          : `${id}|playlist`
        bootstrapCoordinator = createPlaylistBootstrapCoordinator((items) => {
          if (canvaMode) {
            setPlaylistCanvas(items)
          } else {
            setPlaylist(items)
          }
          setCurrentPlaylist(items)
          setCurrentIndex(0)
        })
        localPlaylistPromise = playlistManifestStore.load(manifestKey)
        localPlaylistPromise.then((localPlaylist) => {
          bootstrapCoordinator?.applyLocal(localPlaylist)
        })
        const db = getDatabase()

        const playlistRef = ref(db, `devices/${id}/playlist`)
        const volumeRef = ref(db, `devices/${id}/volume`)
        const rotationRef = ref(db, `devices/${id}/rotation`)
        const playlistCanvasRef =
          canvaMode && dropzoneIndex !== undefined
            ? ref(db, `devices/${id}/playlistCanvas/${dropzoneIndex}`)
            : null

        // Listener para playlist normal
        unsubscribers.push(
          onValue(playlistRef, (snapshot) => {
            if (!isMounted) return

            if (canvaMode) {
              const backgroundPlaylist = sanitizePlaylist(snapshot.val())
              if (backgroundPlaylist !== null) {
                setPlaylist(backgroundPlaylist)
              }
              return
            }

            const remotePlaylist = bootstrapCoordinator.applyRemote(
              snapshot.val()
            )
            if (remotePlaylist === null) {
              console.error('Ignoring invalid remote playlist')
              return
            }

            playlistManifestStore
              .save(manifestKey, remotePlaylist)
              .catch((manifestError) => {
                if (isMounted) {
                  console.error('Failed to persist playlist:', manifestError)
                }
              })
          })
        )

        // Listener para playlist canvas en modo canva
        if (playlistCanvasRef) {
          unsubscribers.push(
            onValue(playlistCanvasRef, (snapshot) => {
              if (!isMounted) return

              const remotePlaylist = bootstrapCoordinator.applyRemote(
                snapshot.val()
              )
              if (remotePlaylist === null) {
                console.error('Ignoring invalid remote canvas playlist')
                return
              }

              playlistManifestStore
                .save(manifestKey, remotePlaylist)
                .catch((manifestError) => {
                  if (isMounted) {
                    console.error(
                      'Failed to persist canvas playlist:',
                      manifestError
                    )
                  }
                })
            })
          )
        }

        unsubscribers.push(
          onValue(volumeRef, (snapshot) => {
            if (!isMounted) return

            const volumeValue = snapshot.val()
            if (volumeValue !== null) {
              setVolume(volumeValue / 100)
            }
          })
        )

        unsubscribers.push(
          onValue(rotationRef, (snapshot) => {
            if (!isMounted) return

            const rotationValue = snapshot.val()
            if (rotationValue !== null) {
              setRotation(rotationValue)
            }
          })
        )

      } catch (error) {
        if (!isMounted) return

        console.error('Error fetching data:', error)
        if (localPlaylistPromise !== null) return

        setError('Error al cargar los datos')
        setIsLoading(false)
      }
    }

    fetchData()

    return () => {
      isMounted = false
      bootstrapCoordinator?.deactivate()
      clearTimeout(imageTimeoutRef.current)
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [canvaMode, dropzoneIndex])

  // Actualiza la lista actual y reinicia el índice cuando la playlist cambia
  useEffect(() => {
    setCurrentPlaylist(canvaMode ? playlistCanvas : playlist)
    setCurrentIndex(0)
  }, [canvaMode, playlist, playlistCanvas])

  // Actualiza currentItem según el currentPlaylist e índice
  useEffect(() => {
    if (currentPlaylist.length > 0) {
      setCurrentItem(currentPlaylist[currentIndex])
    } else {
      setCurrentItem(null)
    }
  }, [currentPlaylist, currentIndex])

  const playNextItem = useCallback(() => {
    const playlistLength = playlistLengthRef.current
    if (playlistLength > 0) {
      setCurrentIndex((prevIndex) => (prevIndex + 1) % playlistLength)
    }
  }, [])

  const advanceCurrentItem = useCallback((generation) => {
    if (
      !claimPlaybackTransition(
        generation,
        activeGenerationRef,
        transitionHandledGenerationRef
      )
    ) return

    playNextItem()
  }, [playNextItem])

  const handleMediaFailure = useCallback(
    (generation, message, details) => {
      if (
        !claimPlaybackTransition(
          generation,
          activeGenerationRef,
          transitionHandledGenerationRef
        )
      ) return

      clearTimeout(imageTimeoutRef.current)
      clearTimeout(recoveryTimeoutRef.current)
      setIsLoading(false)
      setError(message)

      if (details) console.error(message, details)

      if (playlistLengthRef.current > 1) {
        recoveryTimeoutRef.current = setTimeout(() => {
          if (activeGenerationRef.current !== generation) return

          recoveryTimeoutRef.current = null
          playNextItem()
        }, MEDIA_ERROR_DISPLAY_MS)
      }
    },
    [playNextItem]
  )
  watchdogFailureHandlerRef.current = (generation) =>
    handleMediaFailure(generation, 'Video playback stalled')

  useEffect(
    () => () => {
      videoWatchdogRef.current.destroy()
    },
    []
  )

  // Al cambiar currentItem, determina el tipo de media y cachea el archivo
  useEffect(() => {
    let isCurrentItem = true
    let sourceLease
    let generation = null

    clearTimeout(recoveryTimeoutRef.current)
    recoveryTimeoutRef.current = null
    transitionHandledGenerationRef.current = null
    setError(null)

    if (currentItem) {
      generationCounterRef.current += 1
      generation = generationCounterRef.current
      activeGenerationRef.current = generation
      setSourceGeneration(generation)

      const remoteUrl = currentItem.videoUrl
      const mediaType = getMediaType(currentItem.videoUrl)
      currentMediaTypeRef.current = mediaType
      setIsImage(mediaType === MediaType.IMAGE)
      setIsLoading(true)
      setLocalUri(null)

      if (mediaType === MediaType.UNKNOWN) {
        handleMediaFailure(generation, 'Unsupported media format')
        return () => {
          isCurrentItem = false
          if (activeGenerationRef.current === generation) {
            activeGenerationRef.current = null
          }
          clearTimeout(recoveryTimeoutRef.current)
        }
      }

      mediaCacheManager.acquire(remoteUrl).then((acquiredSource) => {
        if (
          !isCurrentItem ||
          activeGenerationRef.current !== generation
        ) {
          acquiredSource.release()
          return
        }

        sourceLease = acquiredSource
        setLocalUri(acquiredSource.uri)
        setIsLoading(false)

        if (mediaType === MediaType.IMAGE) {
          clearTimeout(imageTimeoutRef.current)
          imageTimeoutRef.current = setTimeout(
            () => advanceCurrentItem(generation),
            20000
          )
        }

        if (acquiredSource.cachePromise) {
          acquiredSource.cachePromise.catch((err) => {
            console.error('Error caching media:', err)
          })
        }
      })
        .catch((err) => {
          if (
            !isCurrentItem ||
            activeGenerationRef.current !== generation
          ) {
            return
          }

          console.error('Error resolving media:', err)
          setLocalUri(remoteUrl)
          setIsLoading(false)
        })
    } else {
      activeGenerationRef.current = null
      currentMediaTypeRef.current = MediaType.UNKNOWN
      setLocalUri(null)
      setSourceGeneration(null)
    }

    return () => {
      isCurrentItem = false
      if (activeGenerationRef.current === generation) {
        activeGenerationRef.current = null
      }
      sourceLease?.release()
      clearTimeout(imageTimeoutRef.current)
      clearTimeout(recoveryTimeoutRef.current)
      if (generation !== null) {
        videoWatchdogRef.current.deactivate(generation)
      }
    }
  }, [currentItem, advanceCurrentItem, handleMediaFailure])

  const getMediaType = (url) => {
    if (typeof url !== 'string') return MediaType.UNKNOWN

    const pathname = url.split(/[?#]/, 1)[0].toLowerCase()
    const fileName = pathname.substring(pathname.lastIndexOf('/') + 1)
    const extensionIndex = fileName.lastIndexOf('.')
    if (extensionIndex < 0) return MediaType.UNKNOWN

    const extension = fileName.substring(extensionIndex)
    if (VIDEO_EXTENSIONS.has(extension)) return MediaType.VIDEO
    if (IMAGE_EXTENSIONS.has(extension)) return MediaType.IMAGE
    return MediaType.UNKNOWN
  }

  const handleImageError = useCallback(
    (generation, event) =>
      handleMediaFailure(
        generation,
        'Unable to display image',
        event?.nativeEvent
      ),
    [handleMediaFailure]
  )

  const handleImageLoad = useCallback((generation) => {
    if (
      activeGenerationRef.current !== generation ||
      currentMediaTypeRef.current !== MediaType.IMAGE ||
      transitionHandledGenerationRef.current === generation
    ) {
      return
    }

    setError(null)
    setIsLoading(false)
  }, [])

  // Configura el reproductor usando expo-video
  const player = useVideoPlayer('', (player) => {
    player.audioMixingMode = 'mixWithOthers'
    player.loop = currentPlaylist.length === 1 // Loop si hay un solo elemento
    player.timeUpdateEventInterval = 1
    player.volume = volume
  })

  useEffect(() => {
    if (sourceGeneration === null) return

    const generation = sourceGeneration
    const playToEndSubscription = player.addListener(
      'playToEnd',
      () => {
        if (activeVideoGenerationRef.current !== generation) return

        if (playlistLengthRef.current > 1) advanceCurrentItem(generation)
        if (playlistLengthRef.current === 1) {
          videoWatchdogRef.current.activate(generation)
        } else {
          videoWatchdogRef.current.deactivate(generation)
        }
      }
    )
    const statusChangeSubscription = player.addListener(
      'statusChange',
      ({ status, error: playerError }) => {
        if (
          activeGenerationRef.current !== generation ||
          currentMediaTypeRef.current !== MediaType.VIDEO ||
          activeVideoGenerationRef.current !== generation
        ) {
          return
        }

        if (status === 'error') {
          videoWatchdogRef.current.deactivate(generation)
          handleMediaFailure(
            generation,
            'Unable to play video',
            playerError?.message
          )
        } else if (status === 'loading') {
          videoWatchdogRef.current.allowGrace(generation)
        } else if (
          status === 'readyToPlay' &&
          transitionHandledGenerationRef.current !== generation
        ) {
          setError(null)
          if (!player.playing) {
            player.play()
          }
        }
      }
    )
    const playingChangeSubscription = player.addListener(
      'playingChange',
      ({ isPlaying }) => {
        if (
          activeGenerationRef.current !== generation ||
          activeVideoGenerationRef.current !== generation
        ) {
          return
        }

        if (!isPlaying) {
          videoWatchdogRef.current.allowGrace(generation)
        }
      }
    )
    const timeUpdateSubscription = player.addListener(
      'timeUpdate',
      ({ currentTime }) => {
        if (
          activeGenerationRef.current !== generation ||
          activeVideoGenerationRef.current !== generation
        ) {
          return
        }

        videoWatchdogRef.current.recordProgress(generation, currentTime)
      }
    )

    return () => {
      playToEndSubscription.remove()
      statusChangeSubscription.remove()
      playingChangeSubscription.remove()
      timeUpdateSubscription.remove()
    }
  }, [player, sourceGeneration, advanceCurrentItem, handleMediaFailure])

  // Cuando cambia la URL local y el item es video, se actualiza el reproductor
  useEffect(() => {
    if (
      localUri &&
      sourceGeneration !== null &&
      activeGenerationRef.current === sourceGeneration &&
      currentItem &&
      getMediaType(currentItem.videoUrl) === MediaType.VIDEO
    ) {
      activeVideoGenerationRef.current = sourceGeneration
      videoWatchdogRef.current.activate(sourceGeneration)
      player.replace(localUri)
      return () => {
        videoWatchdogRef.current.deactivate(sourceGeneration)
        if (activeVideoGenerationRef.current === sourceGeneration) {
          activeVideoGenerationRef.current = null
        }
      }
    }

    activeVideoGenerationRef.current = null
  }, [localUri, sourceGeneration, currentItem])

  // Actualiza dinámicamente el volumen
  useEffect(() => {
    if (player) {
      player.volume = volume
    }
  }, [volume])

  // Actualiza la propiedad de looping según la playlist
  useEffect(() => {
    if (player) {
      player.loop = currentPlaylist.length === 1
    }
  }, [currentPlaylist])

  const renderMedia = () => {
    if (!currentItem || !localUri) return null

    // Calcula el estilo de rotación y posición
    const rotationAngle = rotation || 0
    const videoDimensions = isPortrait() ? { width, height } : { width, height }
    const rotationStyle = {
      transform: [{ rotate: `${rotationAngle}deg` }],
      position: canvaMode ? 'relative' : 'absolute',
      top: (height - videoDimensions.height) / 2,
      left: (width - videoDimensions.width) / 2,
      width: videoDimensions.width,
      height: videoDimensions.height,
    }

    if (getMediaType(currentItem.videoUrl) === MediaType.VIDEO) {
      return (
        <VideoView
          style={rotationStyle}
          player={player}
          contentFit='contain'
          nativeControls={false}
          allowsFullscreen
          allowsPictureInPicture={isPictureInPictureSupported()}
          startsPictureInPictureAutomatically={isPictureInPictureSupported()}
        />
      )
    } else if (getMediaType(currentItem.videoUrl) === MediaType.IMAGE) {
      return (
        <Image
          source={{ uri: localUri }}
          style={rotationStyle}
          resizeMode='contain'
          onLoad={() => handleImageLoad(sourceGeneration)}
          onError={(event) => handleImageError(sourceGeneration, event)}
        />
      )
    }
    return null
  }

  useEffect(() => {
    const fetchDeviceQRCode = async () => {
      const id = await getDeviceId()
      const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(
        id
      )}`
      setQrUrl(qrApiUrl)
    }
    fetchDeviceQRCode()
  }, [])

  if (isLoading) {
    return (
      <View style={styles.container}>
        {renderMedia()}
        {!currentItem && deviceId && (
          <View
            style={{
              transform: [{ rotate: isPortrait() ? '0deg' : '270deg' }],
            }}
          >
            <Text style={styles.noContentText}>
              No hay contenido disponible
            </Text>
            <Text style={styles.noContentText}>deviceId: {deviceId}</Text>
            {qrUrl ? (
              <Image source={{ uri: qrUrl }} style={styles.qrCode} />
            ) : (
              <Text>Loading...</Text>
            )}
          </View>
        )}
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
      {!currentItem && deviceId && (
        <View
          style={{ transform: [{ rotate: isPortrait() ? '0deg' : '270deg' }] }}
        >
          <Text style={styles.noContentText}>No hay contenido disponible</Text>
          <Text style={styles.noContentText}>deviceId: {deviceId}</Text>
          {qrUrl ? (
            <Image source={{ uri: qrUrl }} style={styles.qrCode} />
          ) : (
            <Text>Loading...</Text>
          )}
        </View>
      )}
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
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
  },
  qrCode: {
    width: 150,
    height: 150,
    marginTop: 10,
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
})
