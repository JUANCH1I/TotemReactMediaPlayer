import React, { useEffect, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  SafeAreaView,
} from 'react-native'
import axios from 'axios'
import { Feather } from '@expo/vector-icons'
import { isPortrait, widthScreen, heightScreen } from './utils/portrait'

// TODO(seguridad): mover a variable de entorno junto con el resto de las keys.
const API_KEY = 'a4c1b5215f0503cc9d10fa7ed2055c70'
const DEFAULT_CITY = 'Quito'
const WEATHER_REFRESH_MS = 10 * 60 * 1000 // refresca el clima cada 10 min (24/7)

const WeatherCard = ({
  width = widthScreen,
  height = heightScreen,
  location = DEFAULT_CITY,
}) => {
  const [weatherData, setWeatherData] = useState(null)
  const [forecast, setForecast] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [currentTime, setCurrentTime] = useState(new Date())

  useEffect(() => {
    const city =
      location && typeof location === 'string' && location.trim() !== ''
        ? location.trim()
        : DEFAULT_CITY

    const timeInterval = setInterval(() => {
      setCurrentTime(new Date())
    }, 5000)

    // Clima actual. Si la ciudad no existe, cae a la ciudad por defecto.
    const fetchWeatherData = async (cityName) => {
      try {
        const response = await axios.get(
          `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
            cityName
          )}&units=metric&appid=${API_KEY}`
        )
        setWeatherData(response.data)
        setError(null)
        setLoading(false)
      } catch (err) {
        if (cityName !== DEFAULT_CITY) {
          fetchWeatherData(DEFAULT_CITY)
        } else {
          setError('No se pudo obtener el clima.')
          setLoading(false)
        }
      }
    }

    // Pronóstico REAL (cada 3h). Antes esta sección mostraba datos inventados.
    const fetchForecastData = async (cityName) => {
      try {
        const response = await axios.get(
          `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(
            cityName
          )}&units=metric&appid=${API_KEY}`
        )
        const list = Array.isArray(response.data?.list) ? response.data.list : []
        setForecast(
          list.slice(0, 6).map((item, i) => ({
            time:
              i === 0
                ? 'AHORA'
                : new Date(item.dt * 1000).toLocaleTimeString('es-ES', {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
            iconCode: item.weather?.[0]?.icon,
            precipitation: Math.round((item.pop || 0) * 100),
            temp: Math.round(item.main?.temp ?? 0),
          }))
        )
      } catch (err) {
        // El pronóstico es opcional: si falla, la pantalla sigue mostrando el clima.
        if (cityName !== DEFAULT_CITY) fetchForecastData(DEFAULT_CITY)
      }
    }

    const load = () => {
      fetchWeatherData(city)
      fetchForecastData(city)
    }

    load()
    const weatherInterval = setInterval(load, WEATHER_REFRESH_MS)

    return () => {
      clearInterval(timeInterval)
      clearInterval(weatherInterval)
    }
  }, [location])

  const getWeatherIcon = (iconCode) => {
    switch (iconCode) {
      case '01d':
        return 'sun'
      case '01n':
        return 'moon'
      case '02d':
        return 'cloud-sun'
      case '02n':
        return 'cloud-moon'
      case '03d':
      case '03n':
      case '04d':
      case '04n':
        return 'cloud'
      case '09d':
      case '09n':
        return 'cloud-drizzle'
      case '10d':
      case '10n':
        return 'cloud-rain'
      case '11d':
      case '11n':
        return 'cloud-lightning'
      case '13d':
      case '13n':
        return 'cloud-snow'
      case '50d':
      case '50n':
        return 'wind'
      default:
        return 'cloud'
    }
  }

  const isDaytime = () => {
    const hours = currentTime.getHours()
    return hours >= 6 && hours < 18
  }

  const getBackgroundStyle = () => {
    return isDaytime() ? styles.dayBackground : styles.nightBackground
  }

  const renderWeatherElements = () => {
    if (!weatherData) return null

    const iconName = getWeatherIcon(weatherData.weather[0].icon)
    const isDay = isDaytime()

    return (
      <View style={styles.weatherElements}>
        {iconName === 'sun' && isDay && (
          <Feather name='sun' size={100} color='yellow' style={styles.weatherIcon} />
        )}
        {iconName === 'moon' && !isDay && (
          <Feather name='moon' size={100} color='white' style={styles.weatherIcon} />
        )}
        {(iconName === 'cloud' ||
          iconName === 'cloud-sun' ||
          iconName === 'cloud-moon') && (
          <Feather
            name='cloud'
            size={80}
            color='white'
            style={[styles.weatherIcon, styles.cloud1]}
          />
        )}
        {iconName === 'cloud-rain' && (
          <Feather
            name='cloud-rain'
            size={80}
            color='white'
            style={[styles.weatherIcon, styles.cloud1]}
          />
        )}
        {iconName === 'cloud-snow' && (
          <Feather
            name='cloud-snow'
            size={80}
            color='white'
            style={[styles.weatherIcon, styles.cloud1]}
          />
        )}
      </View>
    )
  }

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size='large' color='#ffffff' />
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

  if (!weatherData) return null

  const formatTime = (date) => {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.centeredContainer}>
        <View
          style={[
            styles.card,
            getBackgroundStyle(),
            {
              width: isPortrait() ? width : height,
              height: isPortrait() ? height : width,
              transform: [{ rotate: isPortrait() ? '0deg' : '270deg' }],
            },
          ]}
        >
          <Text style={styles.timeText}>{formatTime(currentTime)}</Text>

          {renderWeatherElements()}

          <View style={styles.mainContent}>
            <Text style={styles.cityName}>{weatherData.name}</Text>
            <Text style={styles.temperature}>
              {Math.round(weatherData.main.temp)}°
            </Text>
            <Text style={styles.condition}>
              {weatherData.weather[0].description}
            </Text>
            <Text style={styles.highLow}>
              H:{Math.round(weatherData.main.temp_max)}° L:
              {Math.round(weatherData.main.temp_min)}°
            </Text>
          </View>

          {forecast.length > 0 && (
            <View style={styles.forecastContainer}>
              <View style={styles.forecastHeader}>
                <Text style={styles.forecastHeaderText}>Hora</Text>
                <Text style={styles.forecastHeaderText}>Próximas horas</Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.forecastScroll}
              >
                {forecast.map((hour, index) => (
                  <View
                    key={index}
                    style={[
                      styles.hourlyCard,
                      hour.time === 'AHORA' && styles.currentHourCard,
                    ]}
                  >
                    <Text style={styles.hourlyTime}>{hour.time}</Text>
                    <Feather
                      name={getWeatherIcon(hour.iconCode)}
                      size={24}
                      color='white'
                    />
                    <Text style={styles.hourlyPrecip}>{hour.precipitation}%</Text>
                    <Text style={styles.hourlyTemp}>{hour.temp}°</Text>
                  </View>
                ))}
              </ScrollView>
            </View>
          )}
        </View>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  centeredContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    padding: 20,
    borderRadius: 20,
    overflow: 'hidden',
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dayBackground: {
    backgroundColor: '#FFA500',
  },
  nightBackground: {
    backgroundColor: '#001E3C',
  },
  timeText: {
    color: 'white',
    fontSize: 16,
    position: 'absolute',
    top: 20,
    left: 20,
  },
  weatherElements: {
    position: 'absolute',
    top: 60,
    left: 0,
    right: 0,
    bottom: 0,
  },
  weatherIcon: {
    position: 'absolute',
  },
  cloud1: {
    top: 100,
    left: 30,
  },
  cloud2: {
    top: 130,
    right: 30,
  },
  mainContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cityName: {
    color: 'white',
    fontSize: 32,
    fontWeight: '500',
    marginBottom: 10,
  },
  temperature: {
    color: 'white',
    fontSize: 96,
    fontWeight: '200',
  },
  condition: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 24,
    marginVertical: 5,
  },
  highLow: {
    color: 'white',
    fontSize: 18,
  },
  forecastContainer: {
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    padding: 20,
  },
  forecastHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  forecastHeaderText: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 16,
  },
  forecastScroll: {
    paddingBottom: 20,
  },
  hourlyCard: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: 25,
    padding: 15,
    alignItems: 'center',
    marginRight: 10,
    width: 80,
  },
  currentHourCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  hourlyTime: {
    color: 'white',
    fontSize: 14,
    marginBottom: 10,
  },
  hourlyPrecip: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 12,
    marginTop: 10,
  },
  hourlyTemp: {
    color: 'white',
    fontSize: 16,
    marginTop: 5,
  },
  errorText: {
    color: 'white',
    fontSize: 18,
  },
})

export default WeatherCard
