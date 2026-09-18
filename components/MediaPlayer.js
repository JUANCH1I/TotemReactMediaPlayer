import React, { useState, useEffect, useRef, useCallback } from 'react'
import { View, StyleSheet, Image, Text, Dimensions } from 'react-native'
import { getDatabase, ref, onValue } from 'firebase/database'
import { getDeviceId } from './utils/deviceId'
import StatusScreen, { StatusTone } from './StatusScreen'
import SystemVolume from '../modules/system-volume'
import Kiosk from '../modules/kiosk'
import {
  createSystemVolumeController,
  normalizeDashboardVolume,
} from './utils/systemVolumeController'
import mediaCacheManager from './utils/mediaCacheManager'
import playlistManifestStore, {
  createPlaylistBootstrapCoordinator,
  sanitizePlaylist,
} from './utils/playlistManifestStore'
import {
  MediaRecoveryAction,
  resolveMediaRecovery,
} from './utils/mediaRecoveryPolicy'
import { resolveDeviceQrSource } from './utils/deviceQrSource'
import groupStore from './utils/groupStore'
import { normalizeGroupId, resolvePlaylistSource } from './utils/playlistSource'
import { createServerClock } from './utils/serverClock'
import {
  ScheduleFailure,
  TransitionCause,
  TransitionKind,
  computeSchedule,
  isSameSyncConfig,
  normalizeSyncConfig,
  resolveImageDwellMs,
  resolveTransition,
  shouldSeek,
} from './utils/syncSchedule'
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
const VIDEO_STARTUP_GRACE_MS = 20000
const VIDEO_STALL_THRESHOLD_MS = 12000
const VIDEO_MINIMUM_PROGRESS_SECONDS = 0.25
// The disk answer for the group is only worth a short wait: past this the
// dashboard's answer (or the device playlist) is used and the disk ignored.
const GROUP_STORE_TIMEOUT_MS = 2000
// A stored length this far from the file's real length would put every seek
// in the wrong place, so such a playlist plays sequentially instead.
const DURATION_MISMATCH_TOLERANCE_S = 1.5

// The native kiosk module can render a pairing QR without network but does not
// expose it to JS yet. Pointing this at that generator is the only change needed
// once it does; until then the helper falls back to the remote endpoint.
// Falls back to the remote service when the native module is unavailable, so
// the same build still runs on a phone or an unprovisioned television.
const LOCAL_QR_GENERATOR = (payload, size) => Kiosk.qrCode(payload, size)

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

// The schedule counts images by the same rule the player uses to render them.
const isImageItem = (item) => getMediaType(item?.videoUrl) === MediaType.IMAGE

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
  const [qrSource, setQrSource] = useState(null)
  // A retry keeps the same index, so only a changing token can re-run the media
  // effect and hand the item a fresh generation.
  const [retryNonce, setRetryNonce] = useState(0)
  const systemVolumeRef = useRef(null)
  const imageTimeoutRef = useRef(null)
  const recoveryTimeoutRef = useRef(null)
  const retryAttemptsRef = useRef(0)
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
  // Only what the dashboard actually sent: the local default must never be
  // pushed onto the television.
  const dashboardVolumeRef = useRef(null)

  // Group membership and synchronized playback. `groupId` is `undefined` until
  // the disk and the dashboard have been consulted, so the playlist
  // subscription below waits for it and a cold boot reads the right manifest.
  // Groups apply to MediaPlayer mode only: a canvas cell keeps its own
  // dropzone playlist (see playlistSource.js).
  const [groupId, setGroupId] = useState(canvaMode ? null : undefined)
  const [syncConfig, setSyncConfig] = useState(null)
  const syncConfigRef = useRef(null)
  syncConfigRef.current = syncConfig
  const currentIndexRef = useRef(currentIndex)
  currentIndexRef.current = currentIndex
  const currentPlaylistRef = useRef(currentPlaylist)
  currentPlaylistRef.current = currentPlaylist
  const scheduleWarningRef = useRef(null)
  const seekedGenerationRef = useRef(null)
  const failedGenerationRef = useRef(null)
  const holdTimeoutRef = useRef(null)
  // One reload per item at most: a reload that still lands out of place
  // waits out its slot rather than reloading again.
  const restartBudgetRef = useRef(true)
  // A playlist whose stored lengths proved wrong on the real files; keyed by
  // the array reference so the next snapshot gets a fresh chance.
  const scheduleOverrideRef = useRef(null)
  // Where the current item is in its own timeline, so a sync change can tell
  // "already aligned" from "visibly out of place".
  const positionRef = useRef(null)
  const runTransitionRef = useRef(null)
  const serverClockRef = useRef(null)
  if (serverClockRef.current === null) {
    serverClockRef.current = createServerClock({
      subscribeOffset: (listener) => {
        try {
          return onValue(
            ref(getDatabase(), '.info/serverTimeOffset'),
            (snapshot) => listener(snapshot.val())
          )
        } catch (clockError) {
          console.error('Unable to subscribe to the server clock:', clockError)
          return () => {}
        }
      },
    })
  }

  // The group's schedule for `items`, or null when this screen steps
  // sequentially: canvas mode, no group, sync off, or a playlist with a video
  // of unknown length (the dashboard stores 0 when it could not read it).
  const resolveSchedule = useCallback(
    (items) => {
      const sync = syncConfigRef.current
      if (canvaMode || sync === null) return null
      if (scheduleOverrideRef.current?.items === items) return null

      const schedule = computeSchedule({
        items,
        anchorMs: sync.anchorMs,
        nowMs: serverClockRef.current.now(),
        isImage: isImageItem,
      })
      if (schedule.computable) {
        scheduleWarningRef.current = null
        return schedule
      }

      // Once per cause, not once per transition: the same playlist would
      // otherwise log the same line every twenty seconds all night. An empty
      // playlist has nothing to align and is not worth a line at all.
      if (
        schedule.reason !== ScheduleFailure.EMPTY &&
        scheduleWarningRef.current !== schedule.reason
      ) {
        scheduleWarningRef.current = schedule.reason
        console.warn(
          `Synchronized playback unavailable (${schedule.reason}); playing sequentially`
        )
      }
      return null
    },
    [canvaMode]
  )

  const markScheduleUncomputable = useCallback((items, detail) => {
    if (scheduleOverrideRef.current?.items === items) return

    scheduleOverrideRef.current = { items }
    console.warn(
      `Synchronized playback unavailable for this playlist (${detail}); playing sequentially`
    )
  }, [])

  // The shared clock only matters to a grouped MediaPlayer; canvas cells never
  // synchronize, so they do not hold a listener open.
  useEffect(() => {
    if (canvaMode) return undefined

    const clock = serverClockRef.current
    clock.start()
    return () => clock.stop()
  }, [canvaMode])

  // Which group this screen belongs to: the disk answers first so an offline
  // boot picks the right cached manifest, then the dashboard corrects it and
  // the answer is written back for the next boot.
  useEffect(() => {
    if (canvaMode) {
      setGroupId(null)
      return undefined
    }

    let isMounted = true
    let unsubscribe = null
    setGroupId(undefined)

    const resolveGroup = async () => {
      let diskTimeout = null
      try {
        const id = await getDeviceId()
        if (!isMounted) return

        const groupIdPath = `devices/${id}/groupId`
        unsubscribe = onValue(
          ref(getDatabase(), groupIdPath),
          (snapshot) => {
            if (!isMounted) return

            const remoteGroupId = normalizeGroupId(snapshot.val())
            setGroupId(remoteGroupId)
            groupStore.save(remoteGroupId)
          },
          (subscriptionError) => {
            if (!isMounted) return

            // A screen that cannot read its membership plays its own
            // playlist rather than nothing.
            console.error(`Unable to read ${groupIdPath}:`, subscriptionError)
            setGroupId(null)
          }
        )

        // The disk and the dashboard race; whichever answers first unblocks
        // the playlist, and the dashboard's answer overrides when it lands.
        const storedGroupId = await Promise.race([
          groupStore.load(),
          new Promise((resolve) => {
            diskTimeout = setTimeout(() => resolve(null), GROUP_STORE_TIMEOUT_MS)
          }),
        ])
        clearTimeout(diskTimeout)
        if (!isMounted) return

        setGroupId((current) => (current === undefined ? storedGroupId : current))
      } catch (groupError) {
        clearTimeout(diskTimeout)
        if (!isMounted) return

        console.error('Unable to resolve group membership:', groupError)
        // The playlist must still load: an unknown group means "own playlist".
        setGroupId((current) => (current === undefined ? null : current))
      }
    }

    resolveGroup()

    return () => {
      isMounted = false
      unsubscribe?.()
    }
  }, [canvaMode])

  // The group's sync settings. Identical snapshots are dropped so a rewrite of
  // the same anchor does not restart the item that is playing.
  useEffect(() => {
    if (canvaMode || typeof groupId !== 'string') {
      setSyncConfig(null)
      return undefined
    }

    let isMounted = true
    setSyncConfig(null)
    const syncPath = `groups/${groupId}/sync`
    const unsubscribe = onValue(
      ref(getDatabase(), syncPath),
      (snapshot) => {
        if (!isMounted) return

        const next = normalizeSyncConfig(snapshot.val())
        setSyncConfig((current) =>
          isSameSyncConfig(current, next) ? current : next
        )
      },
      (subscriptionError) => {
        if (!isMounted) return

        console.error(`Unable to read ${syncPath}:`, subscriptionError)
        setSyncConfig(null)
      }
    )

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [canvaMode, groupId])

  // Configura el listener de Firebase para la playlist. Se vuelve a suscribir
  // cuando cambia la fuente (dispositivo o grupo); volumen y rotación viven en
  // su propio efecto para no reconectarse con cada cambio de grupo.
  useEffect(() => {
    let isMounted = true
    const unsubscribers = []
    let bootstrapCoordinator = null
    let localPlaylistPromise = null

    // Not until the group is known: subscribing to the device playlist first
    // would flash the wrong content on every boot of a grouped screen.
    if (!canvaMode && groupId === undefined) return undefined

    const fetchData = async () => {
      try {
        const id = await getDeviceId()
        if (!isMounted) return

        const db = getDatabase()
        setDeviceId(id)
        const source = resolvePlaylistSource({
          deviceId: id,
          groupId,
          canvaMode,
          dropzoneIndex,
        })
        const manifestKey = source.manifestKey
        bootstrapCoordinator = createPlaylistBootstrapCoordinator((items) => {
          if (canvaMode) {
            setPlaylistCanvas(items)
          } else {
            setPlaylist(items)
          }
        })
        localPlaylistPromise = playlistManifestStore.load(manifestKey)
        localPlaylistPromise.then((localPlaylist) => {
          bootstrapCoordinator?.applyLocal(localPlaylist)
        })

        // Canvas cells still read the device playlist as their background.
        if (canvaMode) {
          unsubscribers.push(
            onValue(ref(db, `devices/${id}/playlist`), (snapshot) => {
              if (!isMounted) return

              const backgroundPlaylist = sanitizePlaylist(snapshot.val())
              if (backgroundPlaylist !== null) {
                setPlaylist(backgroundPlaylist)
              }
            }, (subscriptionError) => {
              if (!isMounted) return

              console.error(`Unable to read devices/${id}/playlist:`, subscriptionError)
            })
          )
        }

        // The playlist this screen plays: its own, its group's, or its
        // dropzone's, as resolved above.
        if (source.path !== null) {
          unsubscribers.push(
            onValue(ref(db, source.path), (snapshot) => {
              if (!isMounted) return

              const remotePlaylist = bootstrapCoordinator.applyRemote(
                snapshot.val()
              )
              if (remotePlaylist === null) {
                console.error(`Ignoring invalid remote playlist (${source.kind})`)
                return
              }

              playlistManifestStore
                .save(manifestKey, remotePlaylist)
                .catch((manifestError) => {
                  if (isMounted) {
                    console.error('Failed to persist playlist:', manifestError)
                  }
                })
            }, (subscriptionError) => {
              if (!isMounted) return

              console.error(`Unable to read ${source.path}:`, subscriptionError)
              // A group this screen is not allowed to read must not freeze it:
              // dropping the group resolves the source back to the device
              // playlist.
              if (source.kind === 'group') setGroupId(null)
            })
          )
        }
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
  }, [canvaMode, dropzoneIndex, groupId])

  // Volumen y rotación son del dispositivo, siga la playlist que siga.
  useEffect(() => {
    if (!deviceId) return undefined

    let isMounted = true
    const db = getDatabase()
    const unsubscribeVolume = onValue(
      ref(db, `devices/${deviceId}/volume`),
      (snapshot) => {
        if (!isMounted) return

        const level = normalizeDashboardVolume(snapshot.val())
        if (level === null) return

        setVolume(level)
        dashboardVolumeRef.current = level
        systemVolumeRef.current?.setDesiredVolume(level)
      }
    )
    const unsubscribeRotation = onValue(
      ref(db, `devices/${deviceId}/rotation`),
      (snapshot) => {
        if (!isMounted) return

        const rotationValue = snapshot.val()
        if (rotationValue !== null) {
          setRotation(rotationValue)
        }
      }
    )

    return () => {
      isMounted = false
      unsubscribeVolume()
      unsubscribeRotation()
    }
  }, [deviceId])

  // Actualiza la lista actual y reinicia el índice cuando la playlist cambia.
  // Una pantalla sincronizada arranca donde está el grupo, no en el ítem 0.
  useEffect(() => {
    const items = canvaMode ? playlistCanvas : playlist
    setCurrentPlaylist(items)
    restartBudgetRef.current = true
    const transition = resolveTransition({
      schedule: resolveSchedule(items),
      currentIndex: currentIndexRef.current,
      playlistLength: items.length,
      cause: TransitionCause.SNAPSHOT,
    })
    setCurrentIndex(transition.index)
  }, [canvaMode, playlist, playlistCanvas, resolveSchedule])

  // Actualiza currentItem según el currentPlaylist e índice
  useEffect(() => {
    if (currentPlaylist.length > 0) {
      setCurrentItem(currentPlaylist[currentIndex])
    } else {
      setCurrentItem(null)
    }
  }, [currentPlaylist, currentIndex])

  // Backoff is per item: a new item starts from the shortest delay even if the
  // previous one had been failing for hours.
  useEffect(() => {
    retryAttemptsRef.current = 0
  }, [currentItem])

  const retryCurrentItem = useCallback(() => {
    setRetryNonce((previousNonce) => previousNonce + 1)
  }, [])

  // Where the current item is in its own timeline, on the shared clock.
  const resolvePositionMs = (generation) => {
    const position = positionRef.current
    if (position === null || position.generation !== generation) return null

    return serverClockRef.current.now() - position.startedAtMs + position.offsetMs
  }

  // The one place playback moves from. `resolveTransition` decides; this
  // applies: GOTO changes the index, RESTART reloads the item (once per item),
  // HOLD leaves the screen exactly as it is and re-evaluates later. A hold is
  // the synchronized answer to "the group is still on this item": last frame,
  // image or error stays up until the slot runs out. A single-item playlist
  // keeps looping through `player.loop` in both modes, so a synchronized
  // single item only aligns when it (re)starts.
  const runTransition = useCallback(
    (generation, cause) => {
      const wasHolding = holdTimeoutRef.current !== null
      clearTimeout(holdTimeoutRef.current)
      holdTimeoutRef.current = null

      const playlistLength = playlistLengthRef.current
      if (playlistLength === 0) return

      const transition = resolveTransition({
        schedule: resolveSchedule(currentPlaylistRef.current),
        currentIndex: currentIndexRef.current,
        playlistLength,
        cause,
        positionMs: resolvePositionMs(generation),
        // The single-item retry curve is the backoff a failure earns; here it
        // bounds how soon a failed item may be fetched again while the group
        // is still on it.
        backoffMs:
          cause === TransitionCause.RECOVERY
            ? resolveMediaRecovery({
                playlistLength: 1,
                failureCount: retryAttemptsRef.current,
              }).delayMs
            : 0,
        restartAllowed: restartBudgetRef.current,
      })

      if (transition.kind === TransitionKind.GOTO) {
        restartBudgetRef.current = true
        if (transition.index !== currentIndexRef.current) {
          setCurrentIndex(transition.index)
        }
        return
      }
      if (transition.kind === TransitionKind.RESTART) {
        restartBudgetRef.current = false
        retryCurrentItem()
        return
      }
      if (transition.kind !== TransitionKind.HOLD) return
      if (transition.delayMs === null) {
        // A sync change during a hold must not strand the last frame: the
        // pending evaluation runs now under the new settings.
        if (wasHolding) runTransitionRef.current(generation, TransitionCause.END)
        return
      }

      // The screen stays exactly as it is until the slot (or backoff) runs out.
      holdTimeoutRef.current = setTimeout(() => {
        holdTimeoutRef.current = null
        if (activeGenerationRef.current !== generation) return

        runTransitionRef.current(generation, cause)
      }, transition.delayMs)
    },
    [resolveSchedule, retryCurrentItem]
  )
  runTransitionRef.current = runTransition

  const playNextItem = useCallback(() => {
    const generation = activeGenerationRef.current
    // A failed item recovers rather than ends: on the same item that also
    // means waiting out its backoff, not just its slot.
    const cause =
      failedGenerationRef.current === generation
        ? TransitionCause.RECOVERY
        : TransitionCause.END
    runTransition(generation, cause)
  }, [runTransition])

  // A sync change (turned on or off, or a new anchor from the dashboard's
  // resync) is applied right away rather than at the next item boundary.
  useEffect(() => {
    runTransition(activeGenerationRef.current, TransitionCause.SYNC)
  }, [syncConfig, runTransition])

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

      failedGenerationRef.current = generation
      clearTimeout(imageTimeoutRef.current)
      clearTimeout(recoveryTimeoutRef.current)
      setIsLoading(false)
      setError(message)

      if (details) console.error(message, details)

      retryAttemptsRef.current += 1
      const recovery = resolveMediaRecovery({
        playlistLength: playlistLengthRef.current,
        failureCount: retryAttemptsRef.current,
      })
      if (recovery.action === MediaRecoveryAction.NONE) return

      recoveryTimeoutRef.current = setTimeout(() => {
        if (activeGenerationRef.current !== generation) return

        recoveryTimeoutRef.current = null
        if (recovery.action === MediaRecoveryAction.ADVANCE) {
          playNextItem()
        } else {
          retryCurrentItem()
        }
      }, recovery.delayMs)
    },
    [playNextItem, retryCurrentItem]
  )
  watchdogFailureHandlerRef.current = (generation) =>
    handleMediaFailure(generation, 'Video playback stalled')

  useEffect(
    () => () => {
      videoWatchdogRef.current.destroy()
      clearTimeout(holdTimeoutRef.current)
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
    clearTimeout(holdTimeoutRef.current)
    holdTimeoutRef.current = null
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

      // An image is shown for what is left of its slot in the group's cycle;
      // if acquiring it took long enough for the group to move on, it is
      // skipped rather than shown late. Returns false when it was skipped.
      const armImageDwell = () => {
        const schedule = resolveSchedule(currentPlaylistRef.current)
        if (schedule !== null && schedule.index !== currentIndexRef.current) {
          advanceCurrentItem(generation)
          return false
        }

        positionRef.current = {
          generation,
          startedAtMs: serverClockRef.current.now(),
          offsetMs: schedule?.offsetMs ?? 0,
        }
        clearTimeout(imageTimeoutRef.current)
        imageTimeoutRef.current = setTimeout(
          () => advanceCurrentItem(generation),
          resolveImageDwellMs(schedule?.offsetMs)
        )
        return true
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
        if (acquiredSource.cachePromise) {
          acquiredSource.cachePromise.catch((err) => {
            console.error('Error caching media:', err)
          })
        }

        if (mediaType === MediaType.IMAGE && !armImageDwell()) return

        setLocalUri(acquiredSource.uri)
        setIsLoading(false)
      })
        .catch((err) => {
          if (
            !isCurrentItem ||
            activeGenerationRef.current !== generation
          ) {
            return
          }

          console.error('Error resolving media:', err)
          // The remote copy is shown instead, and an image still needs its
          // dwell timer or the screen would sit on it forever.
          if (mediaType === MediaType.IMAGE && !armImageDwell()) return

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
    // retryNonce is a trigger, not data: it re-runs this effect so a retried item
    // is re-acquired under a new generation that stale callbacks cannot claim.
  }, [
    currentItem,
    retryNonce,
    advanceCurrentItem,
    handleMediaFailure,
    resolveSchedule,
  ])

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

    // A screen that displayed the item earned a clean slate, so a blip hours
    // later is retried promptly instead of at the backoff ceiling.
    retryAttemptsRef.current = 0
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

  // Puts a video that just became playable where the group is. Returns false
  // when the group has already moved past it: the transition is then claimed
  // for the scheduled item instead of starting this one late.
  const alignVideoWithSchedule = useCallback(
    (generation) => {
      if (seekedGenerationRef.current === generation) return true

      const items = currentPlaylistRef.current
      const schedule = resolveSchedule(items)
      if (schedule !== null && schedule.index !== currentIndexRef.current) {
        advanceCurrentItem(generation)
        return false
      }

      // Once per generation: a seek re-emits readyToPlay, which must not seek
      // again; a retried item gets a new generation and a fresh alignment.
      seekedGenerationRef.current = generation
      let offsetMs = 0
      if (schedule !== null) {
        const storedSeconds = items[currentIndexRef.current]?.duration
        const fileSeconds = player.duration
        if (
          Number.isFinite(fileSeconds) &&
          fileSeconds > 0 &&
          Math.abs(fileSeconds - storedSeconds) > DURATION_MISMATCH_TOLERANCE_S
        ) {
          // Seeking by a wrong length would land past the real end or in the
          // wrong place on every screen; this playlist plays sequentially.
          markScheduleUncomputable(
            items,
            `stored ${storedSeconds}s, file ${fileSeconds.toFixed(1)}s`
          )
        } else if (shouldSeek(schedule.offsetMs)) {
          player.currentTime = schedule.offsetMs / 1000
          offsetMs = schedule.offsetMs
        }
      }
      positionRef.current = {
        generation,
        startedAtMs: serverClockRef.current.now(),
        offsetMs,
      }
      return true
    },
    [player, resolveSchedule, advanceCurrentItem, markScheduleUncomputable]
  )

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
          retryAttemptsRef.current = 0
          setError(null)
          if (!alignVideoWithSchedule(generation)) return
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
  }, [
    player,
    sourceGeneration,
    advanceCurrentItem,
    handleMediaFailure,
    alignVideoWithSchedule,
  ])

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

  // El deslizador del panel maneja el volumen del televisor, así que el
  // reproductor se queda al máximo y el control remoto ya no puede dejar mudo
  // un tótem. En modo canvas hay varias celdas y ninguna manda sobre el equipo.
  useEffect(() => {
    if (player) {
      player.volume = canvaMode ? volume : 1
    }
  }, [player, volume, canvaMode])

  useEffect(() => {
    if (canvaMode) return undefined

    const controller = createSystemVolumeController({ nativeModule: SystemVolume })
    systemVolumeRef.current = controller
    controller.start()

    if (dashboardVolumeRef.current !== null) {
      controller.setDesiredVolume(dashboardVolumeRef.current)
    }

    return () => {
      controller.destroy()
      systemVolumeRef.current = null
    }
  }, [canvaMode])

  // Actualiza la propiedad de looping según la playlist
  useEffect(() => {
    if (player) {
      player.loop = currentPlaylist.length === 1
    }
  }, [currentPlaylist])

  const renderMedia = () => {
    if (!currentItem || !localUri) return null

    // Calcula el estilo de rotación y posición. Un giro de 90 o 270 grados
    // intercambia los lados, así que el contenido se mide al revés y después
    // se recentra sobre la pantalla.
    const rotationAngle = ((rotation || 0) % 360 + 360) % 360
    const isQuarterTurn = rotationAngle === 90 || rotationAngle === 270
    const videoDimensions = isQuarterTurn
      ? { width: height, height: width }
      : { width, height }
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
          // A SurfaceView ignores view transforms, so a rotated screen needs a
          // TextureView for the frames to rotate with the container. The prop
          // cannot change at runtime, so the key remounts the view instead.
          key={isQuarterTurn ? 'video-texture' : 'video-surface'}
          surfaceType={isQuarterTurn ? 'textureView' : 'surfaceView'}
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
    let isMounted = true

    const fetchDeviceQRCode = async () => {
      const id = await getDeviceId()
      const source = await resolveDeviceQrSource(id, {
        generateLocalQr: LOCAL_QR_GENERATOR,
      })
      if (isMounted) setQrSource(source)
    }
    fetchDeviceQRCode()

    return () => {
      isMounted = false
    }
  }, [])

  if (isLoading) {
    return (
      <View style={styles.container}>
        {renderMedia()}
        {!currentItem && deviceId && (
          <StatusScreen
            tone={StatusTone.READY}
            title='¡Todo listo!'
            message='Escanea este código con el panel para elegir qué se muestra aquí.'
            deviceId={deviceId}
            qrUrl={qrSource?.uri}
            rotation={rotation}
          />
        )}
      </View>
    )
  }

  if (error) {
    return (
      <View style={styles.container}>
        <StatusScreen
          tone={StatusTone.ERROR}
          title='No pudimos reproducir el contenido'
          message={error}
          deviceId={deviceId}
          rotation={rotation}
        />
      </View>
    )
  }

  return (
    <View style={styles.container}>
      {renderMedia()}
      {!currentItem && deviceId && (
        <StatusScreen
          tone={StatusTone.READY}
          title='¡Todo listo!'
          message='Escanea este código con el panel para elegir qué se muestra aquí.'
          deviceId={deviceId}
          qrUrl={qrSource?.uri}
          rotation={rotation}
        />
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
})
