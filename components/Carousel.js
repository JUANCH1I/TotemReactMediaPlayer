import React, { useEffect, useState, useRef } from 'react'
import { View, Animated, StyleSheet, Dimensions, Text, Easing } from 'react-native'
import { Image } from 'expo-image'
import { getDatabase, ref, onValue } from 'firebase/database'
import { getDeviceId } from './utils/deviceId'

const { width: windowWidth, height: windowHeight } = Dimensions.get('window')

export default function ImageCarousel({
  speed = 3000,
  width = windowWidth,
  height = windowHeight,
  dropzoneIndex,
}) {
  const [playlist, setPlaylist] = useState([])
  const [error, setError] = useState(null)
  const scrollX = useRef(new Animated.Value(0)).current

  // Suscripción a la playlist del dropzone. Deps [dropzoneIndex]: el deviceId se
  // resuelve adentro, así no se re-suscribe dos veces (antes dependía de deviceId,
  // que arrancaba null y se seteaba dentro => doble listener).
  useEffect(() => {
    let cancelled = false
    let unsubscribe = null

    const fetchData = async () => {
      try {
        const id = await getDeviceId()
        if (cancelled) return
        const db = getDatabase()
        const playlistRef = ref(db, `devices/${id}/playlistCanvas/${dropzoneIndex}`)

        // onValue devuelve su propia función de desuscripción (antes el cleanup
        // hacía off() sobre otra ruta => el listener real nunca se soltaba).
        unsubscribe = onValue(playlistRef, (snapshot) => {
          const data = snapshot.val()
          const urls = data ? Object.keys(data).map((k) => data[k].videoUrl) : []
          const filtered = urls.filter((url) => {
            try {
              return /\.(jpg|jpeg|png|webp|gif)$/i.test(new URL(url).pathname)
            } catch {
              return false
            }
          })
          setPlaylist(filtered)
        })
      } catch (err) {
        console.error('Error fetching data:', err)
        if (!cancelled) setError('Error al cargar la playlist desde Firebase')
      }
    }

    fetchData()

    return () => {
      cancelled = true
      if (unsubscribe) unsubscribe()
    }
  }, [dropzoneIndex])

  // Animación de scroll continuo. Se detiene al desmontar (antes quedaba viva).
  useEffect(() => {
    if (playlist.length === 0) return
    const totalWidth = width * playlist.length
    scrollX.setValue(0)
    const animation = Animated.loop(
      Animated.timing(scrollX, {
        toValue: -totalWidth,
        duration: speed * playlist.length,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    )
    animation.start()
    return () => animation.stop()
  }, [playlist, scrollX, speed, width])

  if (error) {
    return (
      <View style={[styles.center, { width, height }]}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    )
  }

  if (playlist.length === 0) {
    return (
      <View style={[styles.center, { width, height }]}>
        <Text style={styles.noContentText}>No hay contenido disponible</Text>
      </View>
    )
  }

  return (
    <View style={[styles.carouselContainer, { width, height }]}>
      <Animated.View
        style={{
          flexDirection: 'row',
          width: width * playlist.length * 2,
          height: '100%',
          transform: [{ translateX: scrollX }],
        }}
      >
        {[...playlist, ...playlist].map((uri, index) => (
          <Image
            key={`${uri}-${index}`}
            source={{ uri }}
            style={{ width, height }}
            contentFit="contain"
            cachePolicy="memory-disk"
          />
        ))}
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: {
    backgroundColor: 'black',
    justifyContent: 'center',
    alignItems: 'center',
  },
  carouselContainer: {
    overflow: 'hidden',
  },
  errorText: {
    color: 'red',
    fontSize: 18,
  },
  noContentText: {
    color: 'white',
    fontSize: 18,
  },
})
