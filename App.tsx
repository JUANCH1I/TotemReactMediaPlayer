import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import ErrorBoundary from './components/ErrorBoundary';
import StatusScreen, { StatusTone } from './components/StatusScreen';
import MaintenanceScreen from './components/MaintenanceScreen';
import orientationStore, {
  normalizeAngle,
} from './components/utils/orientationStore';
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
// It takes three presses because it is the only focusable thing on screen, so
// a single press of select would otherwise drop a curious guest into service.
const MAINTENANCE_PRESSES = 3;
const MAINTENANCE_PRESS_WINDOW_MS = 4000;

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
  const [maintenancePin, setMaintenancePin] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);
  const servicePresses = useRef(0);
  const servicePressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const countServicePress = useCallback(() => {
    servicePresses.current += 1;

    if (servicePressTimer.current) {
      clearTimeout(servicePressTimer.current);
    }

    if (servicePresses.current >= MAINTENANCE_PRESSES) {
      servicePresses.current = 0;
      setMaintenanceVisible(true);
      return;
    }

    servicePressTimer.current = setTimeout(() => {
      servicePresses.current = 0;
    }, MAINTENANCE_PRESS_WINDOW_MS);
  }, []);

  // How this screen is mounted, from the device first so the very first frame
  // is already the right way up, then from the dashboard, which owns the value.
  useEffect(() => {
    let isMounted = true;

    orientationStore.load().then((stored: number | null) => {
      if (isMounted && stored !== null) {
        setRotation(stored);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!deviceId) {
      return undefined;
    }

    return onValue(
      ref(getDatabase(), `devices/${deviceId}/rotation`),
      (snapshot) => {
        const angle = normalizeAngle(snapshot.val());
        if (angle === null) {
          return;
        }

        setRotation(angle);
        orientationStore.save(angle);
      },
    );
  }, [deviceId]);

  // The service code is read on every totem, not only provisioned ones.
  useEffect(() => {
    if (!deviceId) {
      return undefined;
    }

    return onValue(
      ref(getDatabase(), `devices/${deviceId}/maintenancePin`),
      (snapshot) => {
        const value = snapshot.val();
        setMaintenancePin(typeof value === 'string' ? value : null);
      },
    );
  }, [deviceId]);

  // Owning the screen is opt in, per totem, from the dashboard. Installing the
  // app must never lock a television on its own: wireless debugging turns
  // itself off on every reboot, so a screen locked by surprise can only be
  // recovered by taking it down and resetting it. The dashboard flag, the
  // service screen and the remote command are the three ways back.
  useEffect(() => {
    if (!deviceId) {
      return undefined;
    }

    try {
      if (!Kiosk.isDeviceOwner()) {
        return undefined;
      }
    } catch (error) {
      return undefined;
    }

    const kioskRef = ref(getDatabase(), `devices/${deviceId}/kioskEnabled`);

    return onValue(kioskRef, (snapshot) => {
      try {
        if (snapshot.val() === true) {
          Kiosk.setAsHome();
          Kiosk.lock();
        } else {
          Kiosk.unlock();
          Kiosk.clearHome();
        }
      } catch (error) {
        console.error('Unable to apply the kiosk setting:', error);
      }
    });
  }, [deviceId]);

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
          rotation={rotation}
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
          rotation={rotation}
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
      <ErrorBoundary>
        <AppNavigator />
      </ErrorBoundary>
      {!maintenanceVisible ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Abrir mantenimiento"
          hasTVPreferredFocus
          onPress={countServicePress}
          style={({ focused }) => [
            styles.serviceTarget,
            { opacity: focused ? 0.9 : 0.05 },
          ]}
        />
      ) : null}
      {maintenanceVisible ? (
        <MaintenanceScreen
          rotation={rotation}
          deviceId={deviceId}
          pin={maintenancePin}
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
