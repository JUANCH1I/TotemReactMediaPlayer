import React, { useState, useEffect, useRef } from 'react'
import { View, StyleSheet, Image, Text, Dimensions } from 'react-native'
import { getDatabase, ref, onValue, off } from 'firebase/database'
import { getDeviceId } from './utils/deviceId'
import { isPortrait } from './utils/portrait'
import * as FileSystem from 'expo-file-system'
import * as Crypto from 'expo-crypto'
import {
  isPictureInPictureSupported,
  useVideoPlayer,
  VideoView,
} from 'expo-video'
import { useEventListener } from 'expo'

const { width: windowWidth, height: windowHeight } = Dimensions.get('window')

const MediaType = {
  VIDEO: 'VIDEO',
  IMAGE: 'IMAGE',
  UNKNOWN: 'UNKNOWN',
}

const mediaCacheDir = `${FileSystem.cacheDirectory}mediaCache/`

export default function MediaPlayer({
  width = windowWidth,
  height = windowHeight,
  canvaMode = false,
  dropzoneIndex, // Prop para canvas
}) {
  const [playlist, setPlaylist] = useState([])
  const [playlistCanvas, setPlaylistCanvas] = useState([])
  const [currentPlaylist, setCurrentPlaylist] = useState([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentItem, setCurrentItem] = useState(null)
  const [isImage, setIsImage] = useState(false)
  const [volume, setVolume] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [deviceId, setDeviceId] = useState(null)
  const [error, setError] = useState(null)
  const [localUri, setLocalUri] = useState(null)
  const [qrUrl, setQrUrl] = useState(null)
  const imageTimeoutRef = useRef(null)

  // Crea el directorio de caché para media
  useEffect(() => {
    FileSystem.makeDirectoryAsync(mediaCacheDir, { intermediates: true })
      .then(() => console.log('Directorio mediaCache creado'))
      .catch((err) =>
        console.error('Error al crear el directorio mediaCache:', err)
      )
  }, [])

  // Configura los listeners de Firebase para playlist, volumen y rotación
  useEffect(() => {
    const fetchData = async () => {
      try {
        const id = await getDeviceId()
        setDeviceId(id)
        const db = getDatabase()

        const playlistRef = ref(db, `devices/${id}/playlist`)
        const volumeRef = ref(db, `devices/${id}/volume`)
        const rotationRef = ref(db, `devices/${id}/rotation`)
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
          cleanCacheForPlaylist(newPlaylist)
        })

        // Listener para playlist canvas en modo canva
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
            cleanCacheForPlaylist(newCanvasPlaylist)
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

  // Actualiza la lista actual y reinicia el índice cuando la playlist cambia
  useEffect(() => {
    setCurrentPlaylist(canvaMode ? playlistCanvas : playlist)
    setCurrentIndex(0)
  }, [canvaMode, playlist, playlistCanvas])

  // Actualiza currentItem según el currentPlaylist e índice
  useEffect(() => {
    if (currentPlaylist.length > 0) {
      setCurrentItem(currentPlaylist[currentIndex])
    } else {
      setCurrentItem(null)
    }
  }, [currentPlaylist, currentIndex])

  // Al cambiar currentItem, determina el tipo de media y cachea el archivo
  useEffect(() => {
    if (currentItem) {
      const mediaType = getMediaType(currentItem.videoUrl)
      setIsImage(mediaType === MediaType.IMAGE)
      setIsLoading(true)
      // Se usa la URL remota inicialmente
      setLocalUri(currentItem.videoUrl)
      // Descarga en segundo plano para cachear el archivo
      cacheMediaFile(currentItem.videoUrl)
        .then((cachedUri) => {
          setLocalUri(cachedUri)
          setIsLoading(false)
          if (mediaType === MediaType.IMAGE) {
            clearTimeout(imageTimeoutRef.current)
            imageTimeoutRef.current = setTimeout(playNextItem, 20000)
          }
        })
        .catch((err) => {
          console.error('Error al cachear media:', err)
          setIsLoading(false)
        })
    } else {
      setLocalUri(null)
    }
    return () => clearTimeout(imageTimeoutRef.current)
  }, [currentItem])

  const playNextItem = () => {
    if (currentPlaylist.length > 0) {
      setCurrentIndex((prevIndex) => (prevIndex + 1) % currentPlaylist.length)
    }
  }

  const getMediaType = (url) => {
    if (url.includes('.mp4') || url.includes('.avi') || url.includes('.mov'))
      return MediaType.VIDEO
    if (url.includes('.jpg') || url.includes('.png') || url.includes('.jpeg'))
      return MediaType.IMAGE
    return MediaType.UNKNOWN
  }

  const handleVideoError = (error) => {
    console.error('Error al reproducir video:', error)
    if (error && error.nativeEvent) {
      console.error('Detalles del error:', error.nativeEvent)
    }
    setError('Error al reproducir el video')
    playNextItem()
  }

  // Función que cachea el archivo en mediaCache
  const cacheMediaFile = async (remoteUrl) => {
    try {
      const cleanUrl = remoteUrl.split('?')[0]
      console.log('Clean URL:', cleanUrl)
      const md5Hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.MD5,
        remoteUrl
      )
      const extension = cleanUrl.substring(cleanUrl.lastIndexOf('.'))
      const localFileName = `${md5Hash}${extension}`
      console.log('Local file name:', localFileName)
      const localPath = `${mediaCacheDir}${localFileName}`
      console.log('Local path:', localPath)

      const fileInfo = await FileSystem.getInfoAsync(localPath)
      if (fileInfo.exists) {
        return localPath
      } else {
        const downloadResult = await FileSystem.downloadAsync(
          remoteUrl,
          localPath
        )
        return downloadResult.uri
      }
    } catch (err) {
      console.error('Error caching media file:', err)
      return remoteUrl
    }
  }

  const getCachedFileName = async (remoteUrl) => {
    const md5Hash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.MD5,
      remoteUrl
    )
    const extension = remoteUrl
      .split('?')[0]
      .substring(remoteUrl.split('?')[0].lastIndexOf('.'))
    return `${md5Hash}${extension}`
  }

  const cleanCacheForPlaylist = async (playlistData) => {
    try {
      const cachedFiles = await FileSystem.readDirectoryAsync(mediaCacheDir)
      const validFiles = await Promise.all(
        playlistData.map(async (item) => await getCachedFileName(item.videoUrl))
      )
      const filesToDelete = cachedFiles.filter(
        (file) => !validFiles.includes(file)
      )
      await Promise.all(
        filesToDelete.map(async (file) => {
          await FileSystem.deleteAsync(`${mediaCacheDir}${file}`)
        })
      )
      console.log('Archivos eliminados de caché:', filesToDelete)
    } catch (error) {
      console.error('Error al limpiar la caché:', error)
    }
  }

  // Configura el reproductor usando expo-video
  const player = useVideoPlayer('', (player) => {
    player.audioMixingMode = 'mixWithOthers'
    player.loop = currentPlaylist.length === 1 // Loop si hay un solo elemento
    player.timeUpdateEventInterval = 1
    player.volume = volume
  })

  // Cuando cambia la URL local y el item es video, se actualiza el reproductor
  useEffect(() => {
    if (
      localUri &&
      currentItem &&
      getMediaType(currentItem.videoUrl) === MediaType.VIDEO
    ) {
      player.replace(localUri)
    }
  }, [localUri, currentItem])

  // Actualiza dinámicamente el volumen
  useEffect(() => {
    if (player) {
      player.volume = volume
    }
  }, [volume])

  // Actualiza la propiedad de looping según la playlist
  useEffect(() => {
    if (player) {
      player.loop = currentPlaylist.length === 1
    }
  }, [currentPlaylist])

  // Escucha los cambios de estado del reproductor para pasar al siguiente video
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'idle') {
      playNextItem()
    } else if (status === 'readyToPlay' && !player.playing) {
      player.play()
    }
  })

  const renderMedia = () => {
    if (!currentItem || !localUri) return null

    // Calcula el estilo de rotación y posición
    const rotationAngle = rotation || 0
    const videoDimensions = isPortrait() ? { width, height } : { width, height }
    const rotationStyle = {
      transform: [{ rotate: `${rotationAngle}deg` }],
      position: canvaMode ? 'relative' : 'absolute',
      top: (height - videoDimensions.height) / 2,
      left: (width - videoDimensions.width) / 2,
      width: videoDimensions.width,
      height: videoDimensions.height,
    }

    if (getMediaType(currentItem.videoUrl) === MediaType.VIDEO) {
      return (
        <VideoView
          style={rotationStyle}
          player={player}
          contentFit='contain'
          nativeControls={false}
          allowsFullscreen
          allowsPictureInPicture={isPictureInPictureSupported()}
          startsPictureInPictureAutomatically={isPictureInPictureSupported()}
        />
      )
    } else if (getMediaType(currentItem.videoUrl) === MediaType.IMAGE) {
      return (
        <Image
          source={{ uri: localUri }}
          style={rotationStyle}
          resizeMode='contain'
          onLoad={() => setIsLoading(false)}
          onError={handleVideoError}
        />
      )
    }
    return null
  }

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

  if (isLoading) {
    return (
      <View style={styles.container}>
        {renderMedia()}
        {!currentItem && deviceId && (
          <View
            style={{
              transform: [{ rotate: isPortrait() ? '0deg' : '270deg' }],
            }}
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
          style={{ transform: [{ rotate: isPortrait() ? '0deg' : '270deg' }] }}
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
