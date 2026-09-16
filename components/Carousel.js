import React, { useEffect, useReducer, useRef, useState } from 'react'
import {
  Animated,
  Easing,
  Image,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { getDatabase, onValue, ref } from 'firebase/database'
import { getDeviceId } from './utils/deviceId'

const IMAGE_PATH_PATTERN = /\.(jpg|jpeg|png)$/i
const MIN_TRANSITION_DURATION_MS = 250

function getImageUrls(data) {
  if (!data) return []

  return Object.values(data)
    .map((item) => item?.videoUrl)
    .filter((url) => {
      if (typeof url !== 'string') return false

      const path = url.split(/[?#]/, 1)[0]
      return IMAGE_PATH_PATTERN.test(path)
    })
}

function carouselReducer(state, action) {
  if (action.type === 'replace') return action.state

  if (
    action.type !== 'advance' ||
    action.revision !== state.revision ||
    state.items.length <= 1
  ) {
    return state
  }

  return {
    ...state,
    currentIndex: (state.currentIndex + 1) % state.items.length,
    activeSlot: state.activeSlot === 0 ? 1 : 0,
  }
}

export default function ImageCarousel({
  speed = 3000,
  width,
  height,
  dropzoneIndex,
}) {
  const windowDimensions = useWindowDimensions()
  const resolvedWidth = Number.isFinite(width) && width > 0
    ? width
    : windowDimensions.width
  const resolvedHeight = Number.isFinite(height) && height > 0
    ? height
    : windowDimensions.height
  const transitionDuration = Number.isFinite(speed)
    ? Math.max(MIN_TRANSITION_DURATION_MS, speed)
    : 3000

  const [carouselState, dispatchCarousel] = useReducer(carouselReducer, null, () => ({
    items: [],
    currentIndex: 0,
    activeSlot: 0,
    revision: 0,
    progress: new Animated.Value(0),
  }))
  const [error, setError] = useState(null)
  const activeAnimationRef = useRef(null)
  const animationGenerationRef = useRef(0)
  const playlistRevisionRef = useRef(0)

  useEffect(() => {
    let isActive = true
    let unsubscribe

    const subscribeToPlaylist = async () => {
      try {
        const deviceId = await getDeviceId()
        if (!isActive) return

        const playlistRef = ref(
          getDatabase(),
          `devices/${deviceId}/playlistCanvas/${dropzoneIndex}`,
        )

        unsubscribe = onValue(
          playlistRef,
          (snapshot) => {
            if (!isActive) return

            const items = getImageUrls(snapshot.val())
            playlistRevisionRef.current += 1

            setError(null)
            dispatchCarousel({
              type: 'replace',
              state: {
                items,
                currentIndex: 0,
                activeSlot: 0,
                revision: playlistRevisionRef.current,
                progress: new Animated.Value(0),
              },
            })
          },
          (firebaseError) => {
            if (!isActive) return

            console.error('Failed to load the image playlist:', firebaseError)
            setError('Unable to load the image playlist.')
          },
        )
      } catch (deviceError) {
        if (!isActive) return

        console.error('Failed to identify this device:', deviceError)
        setError('Unable to identify this device.')
      }
    }

    subscribeToPlaylist()

    return () => {
      isActive = false
      unsubscribe?.()
    }
  }, [dropzoneIndex])

  useEffect(() => {
    animationGenerationRef.current += 1
    const generation = animationGenerationRef.current
    const {
      activeSlot,
      items,
      progress,
      revision,
    } = carouselState

    activeAnimationRef.current?.stop()
    activeAnimationRef.current = null

    if (items.length <= 1) {
      return () => {
        animationGenerationRef.current += 1
      }
    }

    let isStopped = false
    const animation = Animated.timing(progress, {
      toValue: activeSlot === 0 ? 1 : 0,
      duration: transitionDuration,
      easing: Easing.linear,
      useNativeDriver: true,
    })

    activeAnimationRef.current = animation
    animation.start(({ finished }) => {
      if (
        !finished ||
        isStopped ||
        animationGenerationRef.current !== generation
      ) {
        return
      }

      dispatchCarousel({ type: 'advance', revision })
    })

    return () => {
      isStopped = true
      animationGenerationRef.current += 1
      activeAnimationRef.current?.stop()
      activeAnimationRef.current = null
    }
  }, [carouselState, transitionDuration])

  const {
    activeSlot,
    currentIndex,
    items,
    progress: transitionProgress,
  } = carouselState
  const currentUri = items[currentIndex]
  const nextUri = items.length > 1
    ? items[(currentIndex + 1) % items.length]
    : null

  useEffect(() => {
    if (!nextUri) return

    Image.prefetch(nextUri).catch(() => {
      // The visible Image still handles loading when prefetch is unavailable.
    })
  }, [nextUri])

  const firstSlotTranslateX = transitionProgress.interpolate({
    inputRange: [0, 1],
    outputRange: activeSlot === 0
      ? [0, -resolvedWidth]
      : [0, resolvedWidth],
  })
  const secondSlotTranslateX = transitionProgress.interpolate({
    inputRange: [0, 1],
    outputRange: activeSlot === 0
      ? [resolvedWidth, 0]
      : [-resolvedWidth, 0],
  })
  const firstSlotOpacity = transitionProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0],
  })
  const secondSlotOpacity = transitionProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  })
  const firstSlotUri = activeSlot === 0 ? currentUri : nextUri
  const secondSlotUri = activeSlot === 0 ? nextUri : currentUri
  const frameStyle = { width: resolvedWidth, height: resolvedHeight }

  if (error) {
    return (
      <View style={[styles.container, frameStyle]}>
        <Text accessibilityRole='alert' style={styles.errorText}>{error}</Text>
      </View>
    )
  }

  if (!currentUri) {
    return (
      <View style={[styles.container, frameStyle]}>
        <Text style={styles.noContentText}>No content available.</Text>
      </View>
    )
  }

  return (
    <View style={[styles.carouselContainer, frameStyle]}>
      <Animated.View
        pointerEvents='none'
        style={[
          styles.imageFrame,
          frameStyle,
          {
            opacity: firstSlotOpacity,
            transform: [{ translateX: firstSlotTranslateX }],
          },
        ]}
      >
        <Image
          accessible={false}
          source={{ uri: firstSlotUri }}
          style={frameStyle}
          resizeMode='contain'
        />
      </Animated.View>

      {nextUri ? (
        <Animated.View
          pointerEvents='none'
          style={[
            styles.imageFrame,
            frameStyle,
            {
              opacity: secondSlotOpacity,
              transform: [{ translateX: secondSlotTranslateX }],
            },
          ]}
        >
          <Image
            accessible={false}
            source={{ uri: secondSlotUri }}
            style={frameStyle}
            resizeMode='contain'
          />
        </Animated.View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'black',
    justifyContent: 'center',
    alignItems: 'center',
  },
  carouselContainer: {
    backgroundColor: 'black',
    overflow: 'hidden',
  },
  imageFrame: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  errorText: {
    color: 'red',
    fontSize: 18,
    textAlign: 'center',
  },
  noContentText: {
    color: 'white',
    fontSize: 18,
    textAlign: 'center',
  },
})
