import React, { useState, useEffect, useRef, useCallback } from 'react'
import { View, StyleSheet, useWindowDimensions } from 'react-native'
import { getDatabase, ref, onValue, runTransaction } from 'firebase/database'
import { useVideoPlayer, VideoView } from 'expo-video'
import { getDeviceId } from './utils/deviceId'
import StatusScreen, { StatusTone } from './StatusScreen'
import SystemVolume from '../modules/system-volume'
import {
  createSystemVolumeController,
  normalizeDashboardVolume,
} from './utils/systemVolumeController'
import { normalizeAngle } from './utils/orientationStore'
import { normalizeLiveSource, DEFAULT_RETURN_SCREEN } from './utils/liveSource'
import { LIVE_SCREEN_NAME } from './utils/screenNames'
import { createLiveSession, LivePhase } from './utils/liveSession'

// A totem put on a live HLS stream by the dashboard. This screen is
// deliberately separate from the playlist engine: nothing here is cached,
// scheduled or shared with a group. The dashboard takes the screen back by
// writing `currentScreen = live.returnTo`; if the broadcast stays dead for
// long enough, the screen writes that itself so it never sits black all night.
// All of that logic lives in utils/liveSession.js; this file only wires it to
// Firebase, the player and the overlay.

const OVERLAY_COPY = {
  [LivePhase.CONNECTING]: {
    tone: StatusTone.WAITING,
    title: 'Conectando con la transmisión…',
    message: 'Un momento, estamos abriendo la señal en vivo.',
  },
  [LivePhase.RETRYING]: {
    tone: StatusTone.ERROR,
    title: 'Transmisión interrumpida, reintentando…',
    message: 'La señal se cortó. Volvemos a conectar solos en unos segundos.',
  },
  [LivePhase.NONE]: {
    tone: StatusTone.WAITING,
    title: 'Sin transmisión configurada',
    message: 'Elegí una señal en vivo desde el panel para mostrarla aquí.',
  },
}

export default function LiveScreen() {
  const { width, height } = useWindowDimensions()
  const [deviceId, setDeviceId] = useState(null)
  // `undefined` until the first snapshot arrives; `null` afterwards means the
  // dashboard configured nothing (or something unusable).
  const [source, setSource] = useState(undefined)
  const [rotation, setRotation] = useState(0)
  const [phase, setPhase] = useState(LivePhase.CONNECTING)
  const connectedRef = useRef(false)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const deviceIdRef = useRef(deviceId)
  deviceIdRef.current = deviceId
  const systemVolumeRef = useRef(null)
  const dashboardVolumeRef = useRef(null)

  const player = useVideoPlayer('', (instance) => {
    instance.audioMixingMode = 'mixWithOthers'
    instance.loop = false
    instance.timeUpdateEventInterval = 1
    // The dashboard slider drives the television's volume, as in MediaPlayer.
    instance.volume = 1
    // A broadcast is watched at the live edge: ExoPlayer's default 2.5 s of
    // buffer before playback would sit permanently between the screen and
    // the operator. Half a second is enough to absorb the tunnel jitter.
    instance.bufferOptions = {
      minBufferForPlayback: 0.5,
      preferredForwardBufferDuration: 3,
      waitsToMinimizeStalling: false,
    }
  })

  // Hands the screen back to the dashboard's chosen screen. The transaction
  // only replaces 'Live': if the dashboard already moved the screen on, or
  // put it somewhere else, that decision stands.
  const giveUp = useCallback(() => {
    const id = deviceIdRef.current
    if (!id) return Promise.reject(new Error('Device id unknown'))

    const returnTo = sourceRef.current?.returnTo ?? DEFAULT_RETURN_SCREEN
    console.warn(`Live stream unavailable for too long; returning to ${returnTo}`)
    return runTransaction(
      ref(getDatabase(), `devices/${id}/currentScreen`),
      (current) => (current === LIVE_SCREEN_NAME ? returnTo : undefined)
    ).then(undefined, (writeError) => {
      console.error('Unable to leave the live screen:', writeError)
      throw writeError
    })
  }, [])

  const sessionRef = useRef(null)
  if (sessionRef.current === null) {
    sessionRef.current = createLiveSession({
      player,
      isConnected: () => connectedRef.current,
      onGiveUp: giveUp,
      onPhase: setPhase,
    })
  }

  // The broadcast configured for this screen, how the screen is mounted, how
  // loud it should be, and whether the totem can currently reach the server.
  useEffect(() => {
    let isMounted = true
    const unsubscribers = []

    const subscribe = async () => {
      try {
        const id = await getDeviceId()
        if (!isMounted) return

        setDeviceId(id)
        const db = getDatabase()
        const livePath = `devices/${id}/live`
        unsubscribers.push(
          onValue(
            ref(db, livePath),
            (snapshot) => {
              if (!isMounted) return

              setSource(normalizeLiveSource(snapshot.val()))
            },
            (subscriptionError) => {
              if (!isMounted) return

              console.error(`Unable to read ${livePath}:`, subscriptionError)
              setSource(null)
            }
          )
        )
        const rotationPath = `devices/${id}/rotation`
        unsubscribers.push(
          onValue(
            ref(db, rotationPath),
            (snapshot) => {
              if (!isMounted) return

              const angle = normalizeAngle(snapshot.val())
              if (angle !== null) setRotation(angle)
            },
            (subscriptionError) => {
              if (!isMounted) return

              console.error(`Unable to read ${rotationPath}:`, subscriptionError)
            }
          )
        )
        const volumePath = `devices/${id}/volume`
        unsubscribers.push(
          onValue(
            ref(db, volumePath),
            (snapshot) => {
              if (!isMounted) return

              const level = normalizeDashboardVolume(snapshot.val())
              if (level === null) return

              dashboardVolumeRef.current = level
              systemVolumeRef.current?.setDesiredVolume(level)
            },
            (subscriptionError) => {
              if (!isMounted) return

              console.error(`Unable to read ${volumePath}:`, subscriptionError)
            }
          )
        )
        unsubscribers.push(
          onValue(
            ref(db, '.info/connected'),
            (snapshot) => {
              if (!isMounted) return

              connectedRef.current = snapshot.val() === true
            },
            (subscriptionError) => {
              if (!isMounted) return

              console.error('Unable to read .info/connected:', subscriptionError)
              connectedRef.current = false
            }
          )
        )
      } catch (error) {
        if (!isMounted) return

        console.error('Unable to subscribe to the live stream:', error)
        setSource(null)
      }
    }

    subscribe()

    return () => {
      isMounted = false
      connectedRef.current = false
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [])

  // Same television volume control as MediaPlayer, so the dashboard slider
  // keeps working during a broadcast.
  useEffect(() => {
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
  }, [])

  // One session per broadcast. A new `startedAt` with the same URL is a new
  // broadcast and reopens the stream from scratch; a cleared node silences the
  // player and waits (not forever) for the dashboard.
  const hasSnapshot = source !== undefined
  const url = source?.url ?? null
  const startedAt = source?.startedAt ?? null
  useEffect(() => {
    if (!hasSnapshot) return undefined

    const session = sessionRef.current
    session.start(url)

    return () => {
      session.stop()
    }
  }, [hasSnapshot, url, startedAt])

  // Leaving the live screen must never leave audio or a timer behind.
  useEffect(
    () => () => {
      sessionRef.current.stop()
    },
    []
  )

  // Same rotation handling as MediaPlayer: a quarter turn swaps the sides, so
  // the video is measured the other way round and recentred on the screen.
  const rotationAngle = ((rotation || 0) % 360 + 360) % 360
  const isQuarterTurn = rotationAngle === 90 || rotationAngle === 270
  const videoDimensions = isQuarterTurn
    ? { width: height, height: width }
    : { width, height }
  const rotationStyle = {
    transform: [{ rotate: `${rotationAngle}deg` }],
    position: 'absolute',
    top: (height - videoDimensions.height) / 2,
    left: (width - videoDimensions.width) / 2,
    width: videoDimensions.width,
    height: videoDimensions.height,
  }
  const overlay = phase === LivePhase.PLAYING ? null : OVERLAY_COPY[phase]

  return (
    <View style={styles.container}>
      {url !== null ? (
        <VideoView
          style={rotationStyle}
          player={player}
          key={isQuarterTurn ? 'live-texture' : 'live-surface'}
          surfaceType={isQuarterTurn ? 'textureView' : 'surfaceView'}
          contentFit='contain'
          nativeControls={false}
        />
      ) : null}
      {overlay !== null && source !== undefined ? (
        <StatusScreen
          tone={overlay.tone}
          title={overlay.title}
          message={overlay.message}
          deviceId={deviceId}
          rotation={rotation}
        />
      ) : null}
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
})
