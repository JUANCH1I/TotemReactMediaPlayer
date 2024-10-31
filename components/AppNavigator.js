import React, { useState, useEffect } from 'react'
import { View, StyleSheet } from 'react-native'
import { getDatabase, ref, onValue, off } from 'firebase/database'
import MediaPlayer from './MediaPlayer'
import TimeWeatherScreen from './TimeWeatherScreen'
import YouTubePlayer from './YoutubePlayer'
import { getDeviceId } from './utils/deviceId'

const AppNavigator = () => {
  const [currentScreen, setCurrentScreen] = useState('MediaPlayer')

  useEffect(() => {
    const fetchData = async () => {
      try {
        const deviceId = await getDeviceId()
        const db = getDatabase()
        const screenRef = ref(db, `devices/${deviceId}/currentScreen`)

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
      const db = getDatabase()
      const deviceId = getDeviceId()
      const screenRef = ref(db, `devices/${deviceId}/currentScreen`)
      off(screenRef)
    }
  }, [])

  const renderScreen = () => {
    switch (currentScreen) {
      case 'MediaPlayer':
        return <MediaPlayer />
      case 'TimeWeather':
        return <TimeWeatherScreen />
      case 'YoutubePlayer':
        return <YouTubePlayer />
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
