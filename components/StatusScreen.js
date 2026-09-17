import { useEffect, useRef } from 'react'
import {
  Animated,
  Easing,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'

// Full screen state for a totem that is not playing content: connecting,
// failing to reach the server, or waiting to be given a playlist. The screens
// are read from across a room and can stay up for hours, so type is sized from
// the screen, edges keep a safe margin away from the TV overscan area, and the
// block drifts slowly to avoid burning the panel.

export const StatusTone = {
  WAITING: 'waiting',
  ERROR: 'error',
  READY: 'ready',
}

const PALETTE = {
  base: '#102A33',
  deep: '#07171C',
  mist: '#E6F0EF',
  haze: '#7FA0A6',
  signal: '#35D0BA',
  alert: '#E2604A',
}

const TONE_COLOR = {
  [StatusTone.WAITING]: PALETTE.signal,
  [StatusTone.READY]: PALETTE.signal,
  [StatusTone.ERROR]: PALETTE.alert,
}

const RAIL_SEGMENTS = 5
const RAIL_TRACK_OPACITY = 0.14
const DRIFT_RANGE = 16
const DRIFT_DURATION = 45000

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const useTypeScale = (shortSide) => ({
  display: clamp(Math.round(shortSide * 0.105), 30, 76),
  body: clamp(Math.round(shortSide * 0.045), 16, 32),
  meta: clamp(Math.round(shortSide * 0.032), 13, 22),
})

// The rail reads as a signal meter: it climbs while the totem is reaching the
// server, holds still once it is ready, and drops to a single mark on failure.
const SignalRail = ({ tone, height }) => {
  const progress = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (tone !== StatusTone.WAITING) {
      progress.setValue(tone === StatusTone.READY ? 1 : 0)
      return undefined
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: 2200,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: 900,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ])
    )

    animation.start()
    return () => animation.stop()
  }, [progress, tone])

  const color = TONE_COLOR[tone]
  const segmentHeight = Math.round(height / RAIL_SEGMENTS) - 8

  // Segments read bottom up, the way a signal meter fills.
  return (
    <View style={[styles.rail, { height }]} pointerEvents='none'>
      {Array.from({ length: RAIL_SEGMENTS }).map((_, index) => {
        const step = RAIL_SEGMENTS - 1 - index
        const threshold = step / RAIL_SEGMENTS
        const isErrorMark = tone === StatusTone.ERROR && step === 0
        const restingOpacity =
          tone === StatusTone.READY && step === RAIL_SEGMENTS - 1 ? 1 : 0.55

        let opacity = RAIL_TRACK_OPACITY

        if (isErrorMark) {
          opacity = 1
        } else if (tone === StatusTone.READY) {
          opacity = restingOpacity
        } else if (tone === StatusTone.WAITING) {
          opacity = progress.interpolate({
            inputRange: [threshold, Math.min(threshold + 0.25, 1)],
            outputRange: [RAIL_TRACK_OPACITY, 0.9],
            extrapolate: 'clamp',
          })
        }

        return (
          <Animated.View
            // Keyed by tone as well: switching an animated opacity back to a
            // plain number leaves the old animation driving the view.
            key={`${tone}-${index}`}
            style={[
              styles.railSegment,
              { height: segmentHeight, backgroundColor: color, opacity },
            ]}
          />
        )
      })}
    </View>
  )
}

/**
 * @param {{
 *   tone?: string,
 *   title: string,
 *   message?: string | null,
 *   deviceId?: string | null,
 *   qrUrl?: string | null,
 *   actionLabel?: string | null,
 *   onAction?: (() => void) | null,
 *   footnote?: string | null,
 *   rotation?: number,
 * }} props
 */
const StatusScreen = ({
  tone = StatusTone.WAITING,
  title,
  message = null,
  deviceId = null,
  qrUrl = null,
  actionLabel = null,
  onAction = null,
  footnote = null,
  rotation = 0,
}) => {
  const { width, height } = useWindowDimensions()
  const drift = useRef(new Animated.Value(0)).current
  const angle = ((rotation || 0) % 360 + 360) % 360
  const isQuarterTurn = angle === 90 || angle === 270
  const frameWidth = isQuarterTurn ? height : width
  const frameHeight = isQuarterTurn ? width : height
  const shortSide = Math.min(frameWidth, frameHeight)
  const type = useTypeScale(shortSide)
  const stacked = frameWidth < frameHeight * 1.2

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: DRIFT_DURATION,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: DRIFT_DURATION,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    )

    animation.start()
    return () => animation.stop()
  }, [drift])

  const driftStyle = {
    transform: [
      {
        translateY: drift.interpolate({
          inputRange: [0, 1],
          outputRange: [-DRIFT_RANGE, DRIFT_RANGE],
        }),
      },
    ],
  }

  const safePadding = Math.round(shortSide * 0.08)
  const qrSize = clamp(Math.round(shortSide * 0.3), 120, 320)

  return (
    <View
      accessible
      accessibilityRole={tone === StatusTone.ERROR ? 'alert' : 'summary'}
      accessibilityLabel={message ? `${title}. ${message}` : title}
      style={[
        styles.screen,
        {
          width: frameWidth,
          height: frameHeight,
          paddingVertical: safePadding,
          paddingLeft: safePadding,
          paddingRight: safePadding,
          transform: [{ rotate: `${angle}deg` }],
          top: (height - frameHeight) / 2,
          left: (width - frameWidth) / 2,
        },
      ]}
    >
      <SignalRail
        tone={tone}
        height={clamp(Math.round(frameHeight * 0.34), 120, 300)}
      />

      <Animated.View
        style={[
          styles.content,
          driftStyle,
          stacked ? styles.contentStacked : styles.contentSideBySide,
          { paddingLeft: Math.round(safePadding * 0.8) },
        ]}
      >
        <View style={styles.copy}>
          <Text
            accessible
            accessibilityRole='header'
            style={[
              styles.title,
              { fontSize: type.display, lineHeight: Math.round(type.display * 1.1) },
            ]}
          >
            {title}
          </Text>

          {message ? (
            <Text
              style={[
                styles.message,
                {
                  fontSize: type.body,
                  lineHeight: Math.round(type.body * 1.45),
                  marginTop: Math.round(type.body * 0.9),
                },
              ]}
            >
              {message}
            </Text>
          ) : null}

          {deviceId ? (
            <Text
              style={[
                styles.deviceId,
                { fontSize: type.meta, marginTop: Math.round(type.body * 1.4) },
              ]}
            >
              {deviceId}
            </Text>
          ) : null}

          {actionLabel && onAction ? (
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={actionLabel}
              hasTVPreferredFocus
              onPress={onAction}
              style={({ focused, pressed }) => [
                styles.action,
                {
                  marginTop: Math.round(type.body * 1.4),
                  paddingVertical: Math.round(type.body * 0.6),
                  paddingHorizontal: Math.round(type.body * 1.2),
                  borderColor: TONE_COLOR[tone],
                  backgroundColor:
                    focused || pressed ? TONE_COLOR[tone] : 'transparent',
                },
              ]}
            >
              {({ focused, pressed }) => (
                <Text
                  style={[
                    styles.actionLabel,
                    {
                      fontSize: type.body,
                      color: focused || pressed ? PALETTE.deep : PALETTE.mist,
                    },
                  ]}
                >
                  {actionLabel}
                </Text>
              )}
            </Pressable>
          ) : null}

          {footnote ? (
            <Text
              style={[
                styles.footnote,
                { fontSize: type.meta, marginTop: Math.round(type.meta * 0.9) },
              ]}
            >
              {footnote}
            </Text>
          ) : null}
        </View>

        {qrUrl ? (
          <View
            style={[
              styles.qrFrame,
              stacked
                ? { marginTop: Math.round(type.body * 1.6) }
                : { marginLeft: Math.round(safePadding * 1.2) },
              { padding: Math.round(qrSize * 0.06) },
            ]}
          >
            <Image
              source={{ uri: qrUrl }}
              style={{ width: qrSize, height: qrSize }}
              resizeMode='contain'
            />
          </View>
        ) : null}
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PALETTE.base,
  },
  rail: {
    width: 8,
    justifyContent: 'space-between',
  },
  railSegment: {
    width: 8,
    borderRadius: 4,
  },
  content: {
    flex: 1,
    alignItems: 'flex-start',
  },
  contentSideBySide: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  contentStacked: {
    flexDirection: 'column',
    justifyContent: 'center',
  },
  copy: {
    flexShrink: 1,
  },
  title: {
    color: PALETTE.mist,
    fontWeight: '300',
    letterSpacing: -0.5,
  },
  message: {
    color: PALETTE.haze,
    fontWeight: '400',
    maxWidth: 620,
  },
  deviceId: {
    color: PALETTE.mist,
    fontFamily: Platform.select({ android: 'monospace', default: 'Menlo' }),
    letterSpacing: 1.5,
    opacity: 0.85,
  },
  action: {
    borderWidth: 2,
    borderRadius: 2,
    alignSelf: 'flex-start',
  },
  actionLabel: {
    fontWeight: '500',
  },
  footnote: {
    color: PALETTE.haze,
  },
  qrFrame: {
    backgroundColor: PALETTE.mist,
    borderRadius: 2,
  },
})

export default StatusScreen
