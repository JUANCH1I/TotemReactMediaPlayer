import React, { useState, useEffect } from 'react'
import { View, StyleSheet } from 'react-native'
import { getDatabase, ref, onValue } from 'firebase/database'
import MediaPlayer from './MediaPlayer'
import TimeWeatherScreen from './TimeWeatherScreen'
import Canvas from './Canvas'
import Carousel from './Carousel'
import { getDeviceId } from './utils/deviceId'

const SCREEN_COMPONENTS = Object.freeze({
  MediaPlayer,
  TimeWeather: TimeWeatherScreen,
  Canvas,
  Carousel,
})

function resolveScreenComponent(screenName, screenComponents) {
  return Object.prototype.hasOwnProperty.call(screenComponents, screenName)
    ? screenComponents[screenName]
    : screenComponents.MediaPlayer
}

const AppNavigator = () => {
  const [currentScreen, setCurrentScreen] = useState('MediaPlayer')

  useEffect(() => {
    let isMounted = true
    let unsubscribe = null

    const subscribeToScreen = async () => {
      try {
        const deviceId = await getDeviceId()
        if (!isMounted) return

        console.log('Device ID:', deviceId)
        const db = getDatabase()
        const screenRef = ref(db, `devices/${deviceId}/currentScreen`)
        console.log('Screen ref:', screenRef)

        unsubscribe = onValue(screenRef, (snapshot) => {
          if (!isMounted) return

          const screenValue = snapshot.val()
          if (screenValue) {
            console.log('Screen value:', screenValue)
            setCurrentScreen(screenValue)
          }
        })
      } catch (error) {
        if (isMounted) {
          console.error('Error fetching screen data:', error)
        }
      }
    }

    subscribeToScreen()

    return () => {
      isMounted = false
      unsubscribe?.()
      unsubscribe = null
    }
  }, [])

  console.log('Current screen:', currentScreen)
  const ScreenComponent = resolveScreenComponent(
    currentScreen,
    SCREEN_COMPONENTS
  )

  return (
    <View style={styles.container}>
      <ScreenComponent />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
})

export default AppNavigator
