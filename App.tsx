import React, { useCallback, useEffect, useState } from 'react';
import { Platform, SafeAreaView, StatusBar, StyleSheet } from 'react-native';
import { getApp, getApps, initializeApp } from 'firebase/app';
import type { FirebaseApp } from 'firebase/app';
import { getDatabase, ref, update } from 'firebase/database';
import type { Database } from 'firebase/database';
import { getFirestore } from 'firebase/firestore';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import AppNavigator from './components/AppNavigator';
import StatusScreen, { StatusTone } from './components/StatusScreen';
import { getDeviceId } from './components/utils/deviceId';

// A totem usually runs with nobody in the room, so a failed start retries on
// its own instead of waiting for someone to pick up the remote.
const RETRY_DELAY_SECONDS = 20;

const firebaseConfig = {
  apiKey: 'AIzaSyCvF1N2eHIfulW3KhvRbc4zT-QU8CkRHbA',
  authDomain: 'comuntotem.firebaseapp.com',
  databaseURL: 'https://comuntotem-default-rtdb.firebaseio.com',
  projectId: 'comuntotem',
  storageBucket: 'comuntotem.appspot.com',
  messagingSenderId: '1021652945227',
  appId: '1:1021652945227:web:92de2bac91377f68f280ce',
  measurementId: 'G-MQ429HJH9X',
};

type InitializationState = 'initializing' | 'ready' | 'error';

let deviceRegistrationPromise: Promise<void> | null = null;

const initializeFirebaseServices = (): void => {
  const app: FirebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

  getDatabase(app);
  getFirestore(app);
};

const updateDeviceLocation = async (database: Database, deviceId: string): Promise<void> => {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();

    if (status !== 'granted') {
      console.log('Location permission was denied.');
      return;
    }

    const { coords } = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    await update(ref(database, `devices/${deviceId}/location`), {
      latitude: coords.latitude,
      longitude: coords.longitude,
    });
  } catch (error) {
    console.error('Unable to update device location:', error);
  }
};

const registerDevice = async (): Promise<void> => {
  let deviceId: string;
  let database: Database;

  try {
    deviceId = await getDeviceId();
    database = getDatabase();
  } catch (error) {
    console.error('Unable to prepare device registration:', error);
    return;
  }

  try {
    await update(ref(database, `devices/${deviceId}`), {
      isScreenOn: true,
      model: Device.modelName,
      brand: Device.brand,
      os_version: Device.osVersion,
    });
  } catch (error) {
    console.error('Unable to register device information:', error);
  }

  if (Platform.isTV) {
    return;
  }

  await updateDeviceLocation(database, deviceId);
};

const registerDeviceInBackground = (): void => {
  if (!deviceRegistrationPromise) {
    deviceRegistrationPromise = registerDevice().catch((error) => {
      console.error('Unexpected device registration error:', error);
    });
  }
};

export default function App(): React.JSX.Element {
  const [initializationState, setInitializationState] =
    useState<InitializationState>('initializing');
  const [initializationAttempt, setInitializationAttempt] = useState(0);
  const [secondsToRetry, setSecondsToRetry] = useState(RETRY_DELAY_SECONDS);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  const retryNow = useCallback(() => {
    setSecondsToRetry(RETRY_DELAY_SECONDS);
    setInitializationState('initializing');
    setInitializationAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    try {
      initializeFirebaseServices();
      setInitializationState('ready');
      registerDeviceInBackground();
    } catch (error) {
      console.error('Unable to initialize Firebase:', error);
      setInitializationState('error');
    }
  }, [initializationAttempt]);

  useEffect(() => {
    getDeviceId()
      .then(setDeviceId)
      .catch(() => setDeviceId(null));
  }, []);

  useEffect(() => {
    if (initializationState !== 'error') {
      return undefined;
    }

    const countdown = setInterval(() => {
      setSecondsToRetry((seconds) => {
        if (seconds <= 1) {
          retryNow();
          return RETRY_DELAY_SECONDS;
        }

        return seconds - 1;
      });
    }, 1000);

    return () => clearInterval(countdown);
  }, [initializationState, retryNow]);

  if (initializationState === 'initializing') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar hidden />
        <StatusScreen
          tone={StatusTone.WAITING}
          title="Conectando"
          message="La pantalla está buscando su configuración."
          deviceId={deviceId ?? undefined}
        />
      </SafeAreaView>
    );
  }

  if (initializationState === 'error') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar hidden />
        <StatusScreen
          tone={StatusTone.ERROR}
          title="Sin conexión con el servidor"
          message="Revisa la conexión a internet del televisor."
          deviceId={deviceId ?? undefined}
          actionLabel="Reintentar ahora"
          onAction={retryNow}
          footnote={`La pantalla reintenta sola en ${secondsToRetry} s.`}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar hidden />
      <AppNavigator />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
  },
});
