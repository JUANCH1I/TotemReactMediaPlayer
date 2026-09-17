import { useEffect, useRef } from 'react'
import {
  Animated,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'

// Full screen state for a totem that is not playing content: connecting,
// failing to reach the server, or waiting to be given a playlist. These screens
// hang in a dining room, so they are lit like one: warm ground, a pilot lamp
// that says what is going on, and plain language. They are read from across the
// room, can stay up for hours, and must survive the overscan area a television
// crops away, so type is sized from the screen, the edges keep a safe margin,
// and the whole block drifts slowly to avoid burning the panel.

export const StatusTone = {
  WAITING: 'waiting',
  ERROR: 'error',
  READY: 'ready',
}

const PALETTE = {
  base: '#24191C',
  deep: '#170F11',
  cream: '#F6ECE1',
  muted: '#C4A99B',
  honey: '#F2B441',
  ember: '#E8705A',
}

const TONE_COLOR = {
  [StatusTone.WAITING]: PALETTE.honey,
  [StatusTone.READY]: PALETTE.honey,
  [StatusTone.ERROR]: PALETTE.ember,
}

const FONT = {
  regular: 'Nunito-Regular',
  bold: 'Nunito-Bold',
}

const DRIFT_RANGE = 16
const DRIFT_DURATION = 45000

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const useTypeScale = (shortSide) => ({
  display: clamp(Math.round(shortSide * 0.1), 28, 72),
  body: clamp(Math.round(shortSide * 0.044), 16, 31),
  meta: clamp(Math.round(shortSide * 0.03), 13, 21),
})

// The lamp is the pilot light of the totem: breathing while it reaches the
// server, steady once content can arrive, slower and warmer when it failed.
const PilotLamp = ({ tone, size }) => {
  const pulse = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (tone === StatusTone.READY) {
      pulse.setValue(1)
      return undefined
    }

    const duration = tone === StatusTone.ERROR ? 1800 : 1100
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    )

    animation.start()
    return () => animation.stop()
  }, [pulse, tone])

  const color = TONE_COLOR[tone]
  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] })
  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] })

  return (
    <View style={[styles.lampSlot, { width: size * 2.4, height: size * 2.4 }]}>
      <Animated.View
        key={`halo-${tone}`}
        style={[
          styles.lampHalo,
          {
            width: size * 1.6,
            height: size * 1.6,
            borderRadius: size * 0.8,
            backgroundColor: color,
            opacity: tone === StatusTone.READY ? 0.18 : haloOpacity,
            transform: [{ scale: tone === StatusTone.READY ? 1.5 : haloScale }],
          },
        ]}
      />
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
        }}
      />
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
  const qrSize = clamp(Math.round(shortSide * 0.26), 120, 300)
  const glowSize = Math.round(Math.max(frameWidth, frameHeight) * 1.35)

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
          padding: safePadding,
          transform: [{ rotate: `${angle}deg` }],
          top: (height - frameHeight) / 2,
          left: (width - frameWidth) / 2,
        },
      ]}
    >
      {/* Warm light pooling behind the copy, the way a lamp lights a table.
          Stacked circles band visibly, so the falloff comes from an image with
          a real alpha ramp, tinted to whatever the current state is. */}
      <Image
        pointerEvents='none'
        source={require('../assets/images/glow.png')}
        style={[
          styles.glow,
          {
            width: glowSize,
            height: glowSize,
            marginLeft: -glowSize / 2,
            marginTop: -glowSize / 2,
            tintColor: TONE_COLOR[tone],
          },
        ]}
      />

      <Animated.View style={[styles.content, driftStyle]}>
        <PilotLamp tone={tone} size={clamp(Math.round(shortSide * 0.045), 14, 30)} />

        <Text
          style={[
            styles.title,
            {
              fontSize: type.display,
              lineHeight: Math.round(type.display * 1.18),
              marginTop: Math.round(type.body * 0.6),
            },
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
                lineHeight: Math.round(type.body * 1.5),
                marginTop: Math.round(type.body * 0.7),
                maxWidth: Math.min(frameWidth - safePadding * 2, 660),
              },
            ]}
          >
            {message}
          </Text>
        ) : null}

        {qrUrl ? (
          <View
            style={[
              styles.card,
              {
                marginTop: Math.round(type.body * 1.5),
                padding: Math.round(qrSize * 0.09),
                borderRadius: Math.round(qrSize * 0.14),
              },
            ]}
          >
            <Image
              source={{ uri: qrUrl }}
              style={{ width: qrSize, height: qrSize }}
              resizeMode='contain'
            />
            {deviceId ? (
              <>
                <Text
                  style={[
                    styles.cardLabel,
                    { fontSize: type.meta, marginTop: Math.round(type.meta * 0.8) },
                  ]}
                >
                  Código del equipo
                </Text>
                <Text style={[styles.cardCode, { fontSize: type.meta }]}>
                  {deviceId}
                </Text>
              </>
            ) : null}
          </View>
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
                paddingVertical: Math.round(type.body * 0.65),
                paddingHorizontal: Math.round(type.body * 1.6),
                backgroundColor:
                  focused || pressed ? PALETTE.cream : 'transparent',
                borderColor: focused || pressed ? PALETTE.cream : PALETTE.muted,
              },
            ]}
          >
            {({ focused, pressed }) => (
              <Text
                style={[
                  styles.actionLabel,
                  {
                    fontSize: type.body,
                    color: focused || pressed ? PALETTE.base : PALETTE.cream,
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
              { fontSize: type.meta, marginTop: Math.round(type.meta * 1.1) },
            ]}
          >
            {footnote}
          </Text>
        ) : null}

        {deviceId && !qrUrl ? (
          <View
            style={[
              styles.chip,
              {
                marginTop: Math.round(type.body * 1.6),
                paddingVertical: Math.round(type.meta * 0.45),
                paddingHorizontal: Math.round(type.meta * 0.9),
              },
            ]}
          >
            <Text style={[styles.chipText, { fontSize: type.meta }]}>
              Equipo {deviceId}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PALETTE.base,
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    opacity: 0.16,
  },
  content: {
    alignItems: 'center',
  },
  lampSlot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  lampHalo: {
    position: 'absolute',
  },
  title: {
    color: PALETTE.cream,
    fontFamily: FONT.bold,
    textAlign: 'center',
  },
  message: {
    color: PALETTE.muted,
    fontFamily: FONT.regular,
    textAlign: 'center',
  },
  card: {
    backgroundColor: PALETTE.cream,
    alignItems: 'center',
  },
  cardLabel: {
    color: PALETTE.base,
    fontFamily: FONT.regular,
    opacity: 0.6,
  },
  cardCode: {
    color: PALETTE.base,
    fontFamily: FONT.bold,
    letterSpacing: 1.2,
  },
  action: {
    borderWidth: 2,
    borderRadius: 999,
  },
  actionLabel: {
    fontFamily: FONT.bold,
  },
  footnote: {
    color: PALETTE.muted,
    fontFamily: FONT.regular,
    opacity: 0.8,
  },
  chip: {
    borderRadius: 999,
    backgroundColor: PALETTE.deep,
  },
  chipText: {
    color: PALETTE.muted,
    fontFamily: FONT.regular,
    letterSpacing: 1,
  },
})

export default StatusScreen
