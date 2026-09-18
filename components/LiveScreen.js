import React, { useState, useEffect, useRef, useCallback } from 'react'
import { View, StyleSheet, useWindowDimensions } from 'react-native'
import { getDatabase, ref, onValue, set } from 'firebase/database'
import { useVideoPlayer, VideoView } from 'expo-video'
import { getDeviceId } from './utils/deviceId'
import StatusScreen, { StatusTone } from './StatusScreen'
import { normalizeAngle } from './utils/orientationStore'
import { normalizeLiveSource, DEFAULT_RETURN_SCREEN } from './utils/liveSource'
import {
  LIVE_GIVE_UP_MS,
  LiveRecoveryAction,
  createLiveStallWatchdog,
  resolveLiveRecovery,
} from './utils/liveRecovery'

// A totem put on a live HLS stream by the dashboard. This screen is
// deliberately separate from the playlist engine: nothing here is cached,
// scheduled or shared with a group. The dashboard takes the screen back by
// writing `currentScreen = live.returnTo`; if the broadcast stays dead for
// long enough, the screen writes that itself so it never sits black all night.

const LivePhase = {
  // No snapshot of devices/{id}/live yet, or a stream that has not shown a
  // frame since it was (re)opened.
  CONNECTING: 'CONNECTING',
  PLAYING: 'PLAYING',
  RETRYING: 'RETRYING',
  NONE: 'NONE',
}

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
  // A retry keeps the same URL, so only a changing token can reopen it.
  const [attemptNonce, setAttemptNonce] = useState(0)
  const retryTimeoutRef = useRef(null)
  const giveUpTimeoutRef = useRef(null)
  const failingSinceRef = useRef(null)
  const attemptRef = useRef(0)
  const gaveUpRef = useRef(false)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const deviceIdRef = useRef(deviceId)
  deviceIdRef.current = deviceId

  const player = useVideoPlayer('', (instance) => {
    instance.audioMixingMode = 'mixWithOthers'
    instance.loop = false
    instance.timeUpdateEventInterval = 1
  })

  // Hands the screen back to the dashboard's chosen screen, once. The totem
  // writes to its own node exactly as registration and presence do.
  const giveUp = useCallback(() => {
    if (gaveUpRef.current) return
    const id = deviceIdRef.current
    if (!id) return

    gaveUpRef.current = true
    const returnTo = sourceRef.current?.returnTo ?? DEFAULT_RETURN_SCREEN
    console.warn(`Live stream unavailable for too long; returning to ${returnTo}`)
    set(ref(getDatabase(), `devices/${id}/currentScreen`), returnTo).catch(
      (writeError) => {
        console.error('Unable to leave the live screen:', writeError)
        gaveUpRef.current = false
      }
    )
  }, [])

  // The broadcast configured for this screen, and how the screen is mounted.
  useEffect(() => {
    let isMounted = true
    let unsubscribeLive = null
    let unsubscribeRotation = null

    const subscribe = async () => {
      try {
        const id = await getDeviceId()
        if (!isMounted) return

        setDeviceId(id)
        const db = getDatabase()
        const livePath = `devices/${id}/live`
        unsubscribeLive = onValue(
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
        unsubscribeRotation = onValue(
          ref(db, `devices/${id}/rotation`),
          (snapshot) => {
            if (!isMounted) return

            const angle = normalizeAngle(snapshot.val())
            if (angle !== null) setRotation(angle)
          }
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
      unsubscribeLive?.()
      unsubscribeRotation?.()
    }
  }, [])

  // Nothing to show: the screen waits for the dashboard, but not forever.
  useEffect(() => {
    if (source !== null) return undefined

    setPhase(LivePhase.NONE)
    giveUpTimeoutRef.current = setTimeout(giveUp, LIVE_GIVE_UP_MS)

    return () => {
      clearTimeout(giveUpTimeoutRef.current)
      giveUpTimeoutRef.current = null
    }
  }, [source, giveUp])

  // Opening the stream, watching it, and reopening it when it drops.
  const url = source?.url ?? null
  useEffect(() => {
    if (url === null) return undefined

    let isCurrentAttempt = true
    setPhase(LivePhase.CONNECTING)

    const scheduleRetry = (reason) => {
      if (!isCurrentAttempt) return
      isCurrentAttempt = false
      watchdog.stop()
      console.error('Live stream failed:', reason)

      const nowMs = Date.now()
      if (failingSinceRef.current === null) failingSinceRef.current = nowMs
      attemptRef.current += 1
      const recovery = resolveLiveRecovery({
        failingSinceMs: failingSinceRef.current,
        nowMs,
        attempt: attemptRef.current,
      })
      setPhase(LivePhase.RETRYING)
      if (recovery.action === LiveRecoveryAction.GIVE_UP) {
        giveUp()
        return
      }

      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = setTimeout(() => {
        retryTimeoutRef.current = null
        setAttemptNonce((nonce) => nonce + 1)
      }, recovery.delayMs)
    }

    const watchdog = createLiveStallWatchdog({
      onStall: () => scheduleRetry('playback stalled'),
    })

    const statusChangeSubscription = player.addListener(
      'statusChange',
      ({ status, error: playerError }) => {
        if (!isCurrentAttempt) return

        if (status === 'error') {
          scheduleRetry(playerError?.message ?? 'player error')
        } else if (status === 'loading') {
          watchdog.allowGrace()
        } else if (status === 'readyToPlay' && !player.playing) {
          player.play()
        }
      }
    )
    const playingChangeSubscription = player.addListener(
      'playingChange',
      ({ isPlaying }) => {
        if (!isCurrentAttempt) return

        if (isPlaying) {
          // First frame: the stream is healthy again, so a later drop starts
          // its own failure streak from scratch.
          failingSinceRef.current = null
          attemptRef.current = 0
          setPhase(LivePhase.PLAYING)
        } else {
          watchdog.allowGrace()
        }
      }
    )
    const timeUpdateSubscription = player.addListener(
      'timeUpdate',
      ({ currentTime }) => {
        if (!isCurrentAttempt) return

        watchdog.recordProgress(currentTime)
      }
    )
    // A live stream has no end; reaching one means the broadcast dropped.
    const playToEndSubscription = player.addListener('playToEnd', () => {
      scheduleRetry('stream ended')
    })

    watchdog.start()
    player.replace(url)

    return () => {
      isCurrentAttempt = false
      watchdog.stop()
      clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
      statusChangeSubscription.remove()
      playingChangeSubscription.remove()
      timeUpdateSubscription.remove()
      playToEndSubscription.remove()
    }
    // attemptNonce is a trigger, not data: it reopens the same URL after a
    // retry delay under a fresh attempt that stale callbacks cannot reach.
  }, [url, attemptNonce, player, giveUp])

  // Leaving the live screen must never leave a timer behind.
  useEffect(
    () => () => {
      clearTimeout(retryTimeoutRef.current)
      clearTimeout(giveUpTimeoutRef.current)
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
        <View style={styles.overlay} pointerEvents='none'>
          <StatusScreen
            tone={overlay.tone}
            title={overlay.title}
            message={overlay.message}
            deviceId={deviceId}
            rotation={rotation}
          />
        </View>
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
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
})
