import React, { useState, useEffect, useRef } from 'react'
import { View, StyleSheet, Image, Text, Dimensions } from 'react-native'
import { Video } from 'expo-av'
import { getDatabase, ref, onValue, off } from 'firebase/database'
import { getDeviceId } from './utils/deviceId'
import { isPortrait } from './utils/portrait'

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
  dropzoneIndex, // Nueva prop
}) {
  const [playlist, setPlaylist] = useState([])
  const [playlistCanvas, setPlaylistCanvas] = useState([])
  const [currentPlaylist, setCurrentPlaylist] = useState([]) // Lista actual según el modo
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentItem, setCurrentItem] = useState(null)
  const [isImage, setIsImage] = useState(false)
  const [volume, setVolume] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [deviceId, setDeviceId] = useState(null)
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

        // Verificar si estamos en modo canvas y tener un dropzoneIndex
        const playlistCanvasRef =
          canvaMode && dropzoneIndex !== undefined
            ? ref(db, `devices/${id}/playlistCanvas/${dropzoneIndex}`)
            : null

        // Listener para playlist normal
        onValue(playlistRef, (snapshot) => {
          const data = snapshot.val()
          const newPlaylist = data
            ? Object.keys(data)
                .map((key) => data[key])
                .filter((item) => item.videoUrl)
            : []
          setPlaylist(newPlaylist)
          if (!canvaMode) setCurrentPlaylist(newPlaylist)
        })

        // Listener para playlistCanvas si está en modo canvas
        if (playlistCanvasRef) {
          onValue(playlistCanvasRef, (snapshot) => {
            const data = snapshot.val()
            console.log(`Playlist canvas para dropzone ${dropzoneIndex}:`, data)
            const newCanvasPlaylist = data
              ? Object.keys(data)
                  .map((key) => data[key])
                  .filter((item) => item.videoUrl)
              : []
            setPlaylistCanvas(newCanvasPlaylist)
            if (canvaMode) setCurrentPlaylist(newCanvasPlaylist)
          })
        }

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
      // Remover listeners de Firebase
      const db = getDatabase()
      const id = deviceId
      if (id) {
        const playlistRef = ref(db, `devices/${id}/playlist`)
        off(playlistRef)
        if (canvaMode && dropzoneIndex !== undefined) {
          const playlistCanvasRef = ref(
            db,
            `devices/${id}/playlistCanvas/${dropzoneIndex}`
          )
          off(playlistCanvasRef)
        }
        const volumeRef = ref(db, `devices/${id}/volume`)
        off(volumeRef)
        const rotationRef = ref(db, `devices/${id}/rotation`)
        off(rotationRef)
      }
    }
  }, [canvaMode, dropzoneIndex])

  useEffect(() => {
    setCurrentPlaylist(canvaMode ? playlistCanvas : playlist)
    setCurrentIndex(0) // Reiniciar el índice cuando cambia la playlist
  }, [canvaMode, playlist, playlistCanvas])

  useEffect(() => {
    if (deviceId) {
      //sendInitialDeviceData(deviceId)
    }
  }, [deviceId])

  const playNextItem = () => {
    if (currentPlaylist.length > 0) {
      setCurrentIndex((prevIndex) => (prevIndex + 1) % currentPlaylist.length)
    }
  }

  useEffect(() => {
    if (currentPlaylist.length > 0) {
      setCurrentItem(currentPlaylist[currentIndex])
    } else {
      setCurrentItem(null)
    }
  }, [currentPlaylist, currentIndex])

  useEffect(() => {
    if (currentItem) {
      const mediaType = getMediaType(currentItem.videoUrl)
      setIsImage(mediaType === MediaType.IMAGE)
      setIsLoading(false)

      if (mediaType === MediaType.IMAGE) {
        clearTimeout(imageTimeoutRef.current)
        imageTimeoutRef.current = setTimeout(playNextItem, 20000) // 20 segundos para imágenes
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

    // Determinar las dimensiones según la rotación
    const videoDimensions = isPortrait()
      ? { width, height } // Si es vertical, intercambiar ancho y alto
      : { width, height } // Si es horizontal, usar las dimensiones normales

    const rotationStyle = {
      transform: [{ rotate: `${rotationAngle}deg` }],
      position: canvaMode ? 'relative' : 'absolute', // Posicionar de manera relativa en canvas
      top: (height - videoDimensions.height) / 2, // Centrar verticalmente
      left: (width - videoDimensions.width) / 2, // Centrar horizontalmente
      width: videoDimensions.width,
      height: videoDimensions.height,
    }

    const isLooping = currentPlaylist.length === 1
    const videoSourceUrl = currentItem?.videoUrl

    if (!isImage) {
      return (
        <Video
          ref={videoRef}
          source={{ uri: videoSourceUrl }}
          style={rotationStyle}
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
          useNativeControls={false}
        />
      )
    } else {
      return (
        <Image
          source={{ uri: videoSourceUrl }}
          style={rotationStyle}
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
        {renderMedia()}
        {!currentItem && deviceId && (
          <View
            style={[
              { transform: [{ rotate: isPortrait() ? '0deg' : '270deg' }] },
            ]}
          >
            <Text style={styles.noContentText}>
              No hay contenido disponible
            </Text>
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
