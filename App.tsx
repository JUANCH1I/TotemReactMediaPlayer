import React, { useCallback, useEffect, useState } from 'react';
import {
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
} from 'react-native';
import { getApp, getApps, initializeApp } from 'firebase/app';
import type { FirebaseApp } from 'firebase/app';
import { getDatabase, onDisconnect, onValue, ref, serverTimestamp, update } from 'firebase/database';
import type { Database } from 'firebase/database';
import { getFirestore } from 'firebase/firestore';
import * as Device from 'expo-device';
import { useFonts } from 'expo-font';
import * as Location from 'expo-location';
import AppNavigator from './components/AppNavigator';
import StatusScreen, { StatusTone } from './components/StatusScreen';
import MaintenanceScreen from './components/MaintenanceScreen';
import Kiosk from './modules/kiosk';
import { getDeviceId } from './components/utils/deviceId';
import {
  createPresenceReporter,
  SERVER_TIME,
} from './components/utils/presenceReporter';
import { nativeApplicationVersion } from 'expo-application';

// A totem usually runs with nobody in the room, so a failed start retries on
// its own instead of waiting for someone to pick up the remote.
const RETRY_DELAY_SECONDS = 20;

// The service screen is opened from a small target in a corner rather than a
// key combination: the TV event API on this player never delivered a single
// key to JavaScript on a real television, while ordinary focus and press work.
// It is the only focusable thing on screen, so an installer reaches it with an
// arrow and confirms, and a guest has nothing to press by accident.

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

  startPresenceReporting(database, deviceId);

  if (Platform.isTV) {
    return;
  }

  await updateDeviceLocation(database, deviceId);
};

// Presence lives next to registration: the database had no timestamps at all,
// so a screen unplugged a year ago looked exactly like one playing right now.
const startPresenceReporting = (database: Database, deviceId: string): void => {
  const statusRef = ref(database, `devices/${deviceId}`);
  const connectedRef = ref(database, '.info/connected');

  const withServerTime = (payload: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [
        key,
        value === SERVER_TIME ? serverTimestamp() : value,
      ]),
    );

  const reporter = createPresenceReporter({
    client: {
      watchConnection: (callback: (connected: boolean) => void) =>
        onValue(connectedRef, (snapshot) => callback(snapshot.val() === true)),
      // The server writes this on the totem's behalf, so a power cut is
      // reported even though the app never gets to say goodbye.
      armDisconnect: (payload: Record<string, unknown>) =>
        onDisconnect(statusRef).update(withServerTime(payload)),
      write: (payload: Record<string, unknown>) =>
        update(statusRef, withServerTime(payload)),
    },
    details: {
      appVersion: nativeApplicationVersion ?? null,
      model: Device.modelName ?? null,
      osVersion: Device.osVersion ?? null,
    },
  });

  reporter.start();
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
  const [maintenanceVisible, setMaintenanceVisible] = useState(false);

  // On a provisioned totem the app owns the screen: it is what the television
  // comes back to, and it cannot be left. On anything else this is skipped, so
  // the same build still runs on a phone or an unprovisioned television.
  useEffect(() => {
    try {
      if (!Kiosk.isDeviceOwner()) {
        return;
      }

      Kiosk.setAsHome();
      Kiosk.lock();
    } catch (error) {
      console.error('Unable to take over the screen:', error);
    }
  }, []);

  // The status screens ask for Nunito; until it arrives the system face stands
  // in, so a slow font never holds up playback.
  useFonts({
    'Nunito-Regular': require('./assets/fonts/Nunito-Regular.ttf'),
    'Nunito-Bold': require('./assets/fonts/Nunito-Bold.ttf'),
  });

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
          title="Encendiendo la pantalla"
          message="Un momento, estamos buscando tu contenido."
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
          title="No pudimos conectarnos"
          message="Revisa que el televisor tenga internet. Mientras tanto seguimos intentando solos."
          deviceId={deviceId ?? undefined}
          actionLabel="Reintentar ahora"
          onAction={retryNow}
          footnote={`Próximo intento en ${secondsToRetry} s`}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar hidden />
      <AppNavigator />
      {!maintenanceVisible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Abrir mantenimiento"
          hasTVPreferredFocus
          onPress={() => setMaintenanceVisible(true)}
          style={({ focused }) => [
            styles.serviceTarget,
            { opacity: focused ? 0.9 : 0.05 },
          ]}
        />
      ) : null}
      {maintenanceVisible ? (
        <MaintenanceScreen
          deviceId={deviceId}
          onClose={() => setMaintenanceVisible(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
  },
  serviceTarget: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#F2B441',
  },
});
