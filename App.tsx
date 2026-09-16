import React, { useEffect, useState } from 'react';
import {
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { getApp, getApps, initializeApp } from 'firebase/app';
import type { FirebaseApp } from 'firebase/app';
import { getDatabase, ref, update } from 'firebase/database';
import type { Database } from 'firebase/database';
import { getFirestore } from 'firebase/firestore';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import AppNavigator from './components/AppNavigator';
import { getDeviceId } from './components/utils/deviceId';

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

export default function App(): JSX.Element {
  const [initializationState, setInitializationState] =
    useState<InitializationState>('initializing');
  const [initializationAttempt, setInitializationAttempt] = useState(0);

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

  if (initializationState === 'initializing') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar hidden />
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLabel="Starting player"
          style={styles.statusContainer}
        >
          <Text style={styles.statusText}>Starting player…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (initializationState === 'error') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar hidden />
        <View style={styles.statusContainer}>
          <Text
            accessible
            accessibilityRole="alert"
            accessibilityLabel="Playback services could not be initialized"
            style={styles.statusText}
          >
            Playback services could not be initialized.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry initialization"
            onPress={() => {
              setInitializationState('initializing');
              setInitializationAttempt((attempt) => attempt + 1);
            }}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
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
  statusContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  statusText: {
    color: 'white',
    fontSize: 18,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 20,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderColor: 'white',
    borderWidth: 2,
  },
  retryText: {
    color: 'white',
    fontSize: 18,
    fontWeight: '600',
  },
});
