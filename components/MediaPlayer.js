import React, { useState, useEffect, useRef } from 'react'
import { View, StyleSheet, Image, Text, Dimensions } from 'react-native'
import { Video } from 'expo-av'
import { getDatabase, ref, onValue, update } from 'firebase/database'
import { getDeviceId } from './utils/deviceId'

const { width, height } = Dimensions.get('window')

const MediaType = {
  VIDEO: 'VIDEO',
  IMAGE: 'IMAGE',
  UNKNOWN: 'UNKNOWN',
}

export default function MediaPlayer() {
  const [playlist, setPlaylist] = useState([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentItem, setCurrentItem] = useState(null)
  const [isImage, setIsImage] = useState(false)
  const [volume, setVolume] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [deviceId, setDeviceId] = useState(null)
  const [dimensions, setDimensions] = useState(Dimensions.get('window'))
  const [error, setError] = useState(null)
  const videoRef = useRef(null)
  const imageTimeoutRef = useRef(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const id = await getDeviceId()
        setDeviceId(id)
        console.log('Device ID:', id)
        const db = getDatabase()
        const playlistRef = ref(db, `devices/${id}/playlist`)
        const volumeRef = ref(db, `devices/${id}/volume`)
        const rotationRef = ref(db, `devices/${id}/rotation`)

        onValue(playlistRef, (snapshot) => {
          const data = snapshot.val()
          console.log('Playlist data:', data)
          if (data === null) {
            setIsLoading(false)
            return
          }
          if (data) {
            const newPlaylist = Object.values(data).filter(
              (item) => item.videoUrl && item.videoUrl !== 'undefined'
            )
            console.log('Filtered playlist:', newPlaylist)
            setPlaylist(newPlaylist)
            if (newPlaylist.length > 0 && !currentItem) {
              setCurrentItem(newPlaylist[0])
            }
          }
          setIsLoading(false)
        })

        onValue(volumeRef, (snapshot) => {
          const volumeValue = snapshot.val()
          if (volumeValue !== null) {
            setVolume(volumeValue / 100)
          }
        })

        onValue(rotationRef, (snapshot) => {
          const rotationValue = snapshot.val()
          if (rotationValue !== null) {
            setRotation(rotationValue)
          }
        })
      } catch (error) {
        console.error('Error fetching data:', error)
        setError('Error al cargar los datos')
        setIsLoading(false)
      }
    }

    fetchData()

    return () => {
      clearTimeout(imageTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    if (deviceId) {
      sendInitialDeviceData(deviceId)
    }
  }, [deviceId])

  const sendInitialDeviceData = async (id) => {
    try {
      const deviceInfo = {
        isScreenOn: true,
        model: 'unknown',
        brand: 'unknown',
        os_version: 'unknown',
        ip_address: 'unknown',
      }

      const db = getDatabase()
      await update(ref(db, `devices/${id}`), deviceInfo)
      console.log('Device info updated')
    } catch (error) {
      console.error('Error updating device info:', error)
    }
  }

  const playNextItem = () => {
    setCurrentIndex((prevIndex) => (prevIndex + 1) % playlist.length)
  }

  useEffect(() => {
    if (playlist.length > 0) {
      setCurrentItem(playlist[currentIndex])
    }
  }, [playlist, currentIndex])

  useEffect(() => {
    if (currentItem) {
      const mediaType = getMediaType(currentItem.videoUrl)
      setIsImage(mediaType === MediaType.IMAGE)
      setIsLoading(false)
      console.log('Current item:', currentItem)
      console.log('Media type:', mediaType)

      if (mediaType === MediaType.IMAGE) {
        clearTimeout(imageTimeoutRef.current)
        imageTimeoutRef.current = setTimeout(playNextItem, 20000)
      }
    }
  }, [currentItem])

  const getMediaType = (url) => {
    if (url.includes('.mp4') || url.includes('.avi')) return MediaType.VIDEO
    if (url.includes('.jpg') || url.includes('.png') || url.includes('.jpeg'))
      return MediaType.IMAGE
    return MediaType.UNKNOWN
  }

  const handleVideoError = (error) => {
    console.error('Error playing video:', error)
    setError('Error al reproducir el video')
    playNextItem()
  }

  const renderMedia = () => {
    if (!currentItem) return null

    const rotationAngle = rotation || 0
    const isPortrait = rotationAngle === 90 || rotationAngle === 270

    // Determinar las dimensiones según la rotación
    const videoDimensions = isPortrait
      ? { width: height, height: width } // Si es vertical, intercambiar ancho y alto
      : { width, height } // Si es horizontal, usar las dimensiones normales

    const rotationStyle = {
      transform: [{ rotate: `${rotationAngle}deg` }],
      position: 'absolute', // Posicionar de manera absoluta
      top: (height - videoDimensions.height) / 2, // Centrar verticalmente
      left: (width - videoDimensions.width) / 2, // Centrar horizontalmente
      width: videoDimensions.width,
      height: videoDimensions.height,
    }

    if (!isImage) {
      return (
        <Video
          ref={videoRef}
          source={{ uri: currentItem.videoUrl }}
          style={rotationStyle} // Usar el estilo calculado
          shouldPlay={true}
          isMuted={false}
          isLooping={false}
          resizeMode='contain' // Mantener la relación de aspecto
          onPlaybackStatusUpdate={(status) => {
            if (status.didJustFinish) {
              playNextItem()
            }
            if (status.isLoaded) {
              setIsLoading(false)
            }
          }}
          onError={handleVideoError}
          volume={volume}
        />
      )
    } else {
      return (
        <Image
          source={{ uri: currentItem.videoUrl }}
          style={rotationStyle} // Usar el estilo calculado
          resizeMode='contain' // Mantener la relación de aspecto
          onLoad={() => setIsLoading(false)}
          onError={() => {
            setError('Error al cargar la imagen')
            playNextItem()
          }}
        />
      )
    }
  }

  if (isLoading) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Cargando...</Text>
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
        <View>
          <Text style={styles.noContentText}>No hay contenido disponible</Text>
          <Text style={styles.noContentText}>deviceId: {deviceId}</Text>
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
    borderColor: 'yellow',
    borderWidth: 1,
  },
  fullScreen: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    borderColor: 'red',
    borderWidth: 1,
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
