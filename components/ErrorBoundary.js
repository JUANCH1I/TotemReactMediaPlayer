import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import * as Updates from 'expo-updates'
import { getDatabase, ref, update } from 'firebase/database'
import { getDeviceId } from './utils/deviceId'
import { createCrashRecovery } from './utils/crashRecovery'

// The last line of defence for an unattended screen: a render crash anywhere
// below is reported to devices/{id}/lastError and the app reloads itself. The
// timing and the guards live in utils/crashRecovery.js; this component only
// wires React, Firebase and expo-updates to it.

const reportCrash = async (crash) => {
  const id = await getDeviceId()
  await update(ref(getDatabase(), `devices/${id}`), { lastError: crash })
}

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: null }
    this.recovery = createCrashRecovery({
      report: reportCrash,
      reload: () => Updates.reloadAsync(),
      recover: () => this.setState({ hasError: false, message: null }),
    })
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message ?? 'Error desconocido' }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack)
    this.recovery.handleCrash(error, info)
  }

  componentWillUnmount() {
    this.recovery.dispose()
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
