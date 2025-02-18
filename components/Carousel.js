import React, { useEffect, useState, useRef } from 'react'
import {
  View,
  Animated,
  StyleSheet,
  Dimensions,
  Text,
  Image,
  Easing,
} from 'react-native'
import { getDatabase, ref, onValue, off } from 'firebase/database'
import { getDeviceId } from './utils/deviceId'

const { width: windowWidth, height: windowHeight } = Dimensions.get('window')

export default function ImageCarousel({
  speed = 3000,
  width = windowWidth,
  height = windowHeight,
  dropzoneIndex,
}) {
  const [playlist, setPlaylist] = useState([])
  const [deviceId, setDeviceId] = useState(null)
  const [error, setError] = useState(null)
  const scrollX = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const fetchData = async () => {
      try {
        const id = await getDeviceId()
        setDeviceId(id)

        const db = getDatabase()
        const playlistRef = ref(
          db,
          `devices/${id}/playlistCanvas/${dropzoneIndex}`
        )

        // Listener para la playlist
        onValue(playlistRef, (snapshot) => {
          const data = snapshot.val()

          const newPlaylist = data
            ? Object.keys(data).map((key) => data[key].videoUrl)
            : []

          // Ajustar el filtro para ignorar los parámetros de la URL
          const filteredPlaylist = newPlaylist.filter((url) => {
            try {
              const path = new URL(url).pathname // Extrae solo el path sin los parámetros
              return path.match(/\.(jpg|jpeg|png)$/i) // Filtrar por extensión válida
            } catch (error) {
              console.error('Error procesando URL:', url, error)
              return false
            }
          })

          console.log('URLs después del filtro:', filteredPlaylist)

          setPlaylist(filteredPlaylist)
        })
      } catch (err) {
        console.error('Error fetching data:', err)
        setError('Error al cargar la playlist desde Firebase')
      }
    }

    fetchData()

    // Cleanup listeners on unmount
    return () => {
      if (deviceId) {
        const db = getDatabase()
        const playlistRef = ref(db, `devices/${deviceId}/playlist`)
        off(playlistRef)
      }
    }
  }, [deviceId])

  useEffect(() => {
    if (playlist.length > 0) {
      const totalWidth = windowWidth * playlist.length

      scrollX.setValue(0)

      Animated.loop(
        Animated.timing(scrollX, {
          toValue: -totalWidth,
          duration: speed * playlist.length,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      ).start()
    }
  }, [playlist, scrollX, speed])

  if (error) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    )
  }

  if (playlist.length === 0) {
    return (
      <View style={styles.container}>
        <Text style={styles.noContentText}>No hay contenido disponible</Text>
      </View>
    )
  }

  return (
    <View style={styles.carouselContainer}>
      <Animated.View
        style={{
          flexDirection: 'row',
          width: windowWidth * playlist.length * 2,
          transform: [
            {
              translateX: scrollX,
            },
          ],
        }}
      >
        {[...playlist, ...playlist].map((uri, index) => (
          <Image
            key={index}
            source={{ uri }}
            style={[styles.image, { width: windowWidth }]}
            resizeMode='contain' // Mantiene el aspecto de la imagen sin recortes
          />
        ))}
      </Animated.View>
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
  carouselContainer: {
    width: windowWidth,
    height: windowHeight / 2,
    overflow: 'hidden',
  },
  image: {
    height: windowHeight / 2,
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
