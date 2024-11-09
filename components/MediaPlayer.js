import React, { useState, useEffect, useRef } from 'react'
import { View, StyleSheet, Image, Text, Dimensions } from 'react-native'
import { Video } from 'expo-av'
import { getDatabase, ref, onValue, update } from 'firebase/database'
import { getDeviceId } from './utils/deviceId'
import { isPortrait } from './utils/portrait'
import * as Device from 'expo-device'
import * as Location from 'expo-location'

const { width: windowWidth, height: windowHeight } = Dimensions.get('window')

const MediaType = {
  VIDEO: 'VIDEO',
  IMAGE: 'IMAGE',
  UNKNOWN: 'UNKNOWN',
}

export default function MediaPlayer({
  width = windowWidth,
  height = windowHeight,
  canvaMode = false,
  videoUrl,
}) {
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
  const [qrUrl, setQrUrl] = useState(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const id = await getDeviceId()
        setDeviceId(id)
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
      //sendInitialDeviceData(deviceId)
    }
  }, [deviceId])

  const sendInitialDeviceData = async (id) => {
    try {
      const deviceInfo = {
        isScreenOn: true,
        model: Device.modelName,
        brand: Device.brand,
        os_version: Device.osVersion,
        location: null, // Inicializamos con null
      }

      // Solicitar permisos de ubicación
      const { status } = await Location.requestForegroundPermissionsAsync()
      if (status !== 'granted') {
        console.log('Permission to access location was denied')
        const db = getDatabase()
        await update(ref(db, `devices/${id}`), deviceInfo)
        return
      }

      // Obtener la ubicación
      const { coords } = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      })

      // Añadir la ubicación al dispositivo
      deviceInfo.location = {
        latitude: coords.latitude,
        longitude: coords.longitude,
      }

      // Actualizar los datos del dispositivo en Firebase
      const db = getDatabase()
      await update(ref(db, `devices/${id}`), deviceInfo)
      console.log('Device info with location updated')
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

      if (mediaType === MediaType.IMAGE) {
        clearTimeout(imageTimeoutRef.current)
        imageTimeoutRef.current = setTimeout(playNextItem, 20000)
      }
    }
  }, [currentItem])

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

  const getMediaType = (url) => {
    if (url.includes('.mp4') || url.includes('.avi') || url.includes('.mov'))
      return MediaType.VIDEO
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
    //const isPortrait = rotationAngle === 90 || rotationAngle === 270

    // Determinar las dimensiones según la rotación
    const videoDimensions = isPortrait()
      ? { width, height } // Si es vertical, intercambiar ancho y alto
      : { width: height, height: width } // Si es horizontal, usar las dimensiones normales

    const rotationStyle = {
      transform: [{ rotate: `${rotationAngle}deg` }],
      position: canvaMode ? 'relative' : 'absolute', // Posicionar de manera absoluta
      top: (height - videoDimensions.height) / 2, // Centrar verticalmente
      left: (width - videoDimensions.width) / 2, // Centrar horizontalmente
      width: videoDimensions.width,
      height: videoDimensions.height,
    }

    const isLooping = playlist.length === 1
    const videoSourceUrl = canvaMode ? videoUrl : currentItem?.videoUrl
    console.log('videoSourceUrl:', videoSourceUrl)
    console.log(canvaMode)

    if (!isImage) {
      return (
        <Video
          ref={videoRef}
          source={{ uri: videoSourceUrl }}
          style={rotationStyle} // Usar el estilo calculado
          shouldPlay={true}
          isMuted={false}
          isLooping={isLooping}
          resizeMode='contain' // Mantener la relación de aspecto
          onPlaybackStatusUpdate={(status) => {
            if (status.didJustFinish && !isLooping) {
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
        <View
          style={[
            { transform: [{ rotate: isPortrait() ? '0deg' : '270deg' }] },
          ]}
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
