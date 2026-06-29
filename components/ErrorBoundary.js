import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import * as Updates from 'expo-updates'
import { getDatabase, ref, update } from 'firebase/database'
import { getDeviceId } from './utils/deviceId'

// Un totem desatendido no puede quedar en una pantalla de error: tras capturar,
// reporta el fallo a Firebase y reinicia la app limpia.
const AUTO_RECOVER_MS = 10000

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: null }
    this.recoverTimer = null
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || 'Error desconocido' }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack)
    this.reportError(error, info)

    this.recoverTimer = setTimeout(async () => {
      try {
        // Reinicio limpio de la app: descarta cualquier estado corrupto.
        await Updates.reloadAsync()
      } catch (_) {
        // En dev o si reloadAsync no está disponible, al menos reintentamos el render.
        this.setState({ hasError: false, message: null })
      }
    }, AUTO_RECOVER_MS)
  }

  componentWillUnmount() {
    clearTimeout(this.recoverTimer)
  }

  // Deja rastro del error en Firebase para diagnosticar el totem de forma remota.
  async reportError(error, info) {
    try {
      const id = await getDeviceId()
      const db = getDatabase()
      await update(ref(db, `devices/${id}`), {
        lastError: {
          message: String(error?.message || error).slice(0, 500),
          stack: String(info?.componentStack || '').slice(0, 1000),
          at: Date.now(),
        },
      })
    } catch (_) {
      // Sin red no podemos reportar; igual nos auto-recuperamos.
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Reiniciando…</Text>
          <Text style={styles.message}>{this.state.message}</Text>
        </View>
      )
    }
    return this.props.children
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    color: 'white',
    fontSize: 24,
    marginBottom: 10,
  },
  message: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 12,
    textAlign: 'center',
  },
})
