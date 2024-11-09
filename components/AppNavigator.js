import React, { useState, useEffect } from 'react'
import { View, StyleSheet } from 'react-native'
import { getDatabase, ref, onValue, off } from 'firebase/database'
import MediaPlayer from './MediaPlayer'
import TimeWeatherScreen from './TimeWeatherScreen'
import YouTubePlayer from './YoutubePlayer'
import Canvas from './Canvas'
import { getDeviceId } from './utils/deviceId'

const AppNavigator = () => {
  const [currentScreen, setCurrentScreen] = useState('MediaPlayer')

  useEffect(() => {
    const fetchData = async () => {
      try {
        const deviceId = await getDeviceId()
        console.log('Device ID:', deviceId)
        const db = getDatabase()
        const screenRef = ref(db, `devices/${deviceId}/currentScreen`)
        console.log('Screen ref:', screenRef)

        onValue(screenRef, (snapshot) => {
          const screenValue = snapshot.val()
          if (screenValue) {
            console.log('Screen value:', screenValue)
            setCurrentScreen(screenValue)
          }
        })
      } catch (error) {
        console.error('Error fetching screen data:', error)
      }
    }

    fetchData()

    return () => {
      const cleanup = async () => {
        try {
          const deviceId = await getDeviceId() // Obtener el ID del dispositivo para limpiar
          console.log('Cleaning up for device ID:', deviceId)
          const db = getDatabase()
          const screenRef = ref(db, `devices/${deviceId}/currentScreen`)
          off(screenRef) // Desconectar la escucha de los cambios
        } catch (error) {
          console.error('Error during cleanup:', error)
        }
      }

      cleanup()
    }
  }, [])

  const renderScreen = () => {
    console.log('Current screen:', currentScreen)
    switch (currentScreen) {
      case 'MediaPlayer':
        return <MediaPlayer />
      case 'TimeWeather':
        return <TimeWeatherScreen />
      case 'YoutubePlayer':
        return <YouTubePlayer />
      case 'Canvas':
        return <Canvas />
      default:
        return <MediaPlayer />
    }
  }

  return <View style={styles.container}>{renderScreen()}</View>
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
})

export default AppNavigator
