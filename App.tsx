import React, { useEffect, useState } from 'react';
import { StyleSheet, SafeAreaView, StatusBar } from 'react-native';
import { initializeApp, FirebaseApp } from 'firebase/app';
import { getDatabase, ref, onValue, update, Database } from 'firebase/database'
import { getFirestore, Firestore } from 'firebase/firestore';
import AppNavigator from './components/AppNavigator';
import { getDeviceId } from './components/utils/deviceId';
import * as Location from 'expo-location'
import * as Device from 'expo-device'



// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCvF1N2eHIfulW3KhvRbc4zT-QU8CkRHbA",
  authDomain: "comuntotem.firebaseapp.com",
  databaseURL: "https://comuntotem-default-rtdb.firebaseio.com",
  projectId: "comuntotem",
  storageBucket: "comuntotem.appspot.com",
  messagingSenderId: "1021652945227",
  appId: "1:1021652945227:web:92de2bac91377f68f280ce",
  measurementId: "G-MQ429HJH9X",
};

const sendInitialDeviceData = async (id) => {
  try {
    const deviceInfo = {
      isScreenOn: true,
      model: Device.modelName,
      brand: Device.brand,
      os_version: Device.osVersion,
      location: null, // Inicializamos con null
    };

    // Solicitar permisos de ubicación
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      console.log('Permission to access location was denied');
      const db = getDatabase();
      await update(ref(db, `devices/${id}`), deviceInfo);
      return;
    }

    // Obtener la ubicación
    const { coords } = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    // Añadir la ubicación al dispositivo
    deviceInfo.location = {
      latitude: coords.latitude,
      longitude: coords.longitude,
    };

    // Actualizar los datos del dispositivo en Firebase
    const db = getDatabase();
    await update(ref(db, `devices/${id}`), deviceInfo);
    console.log('Device info with location updated');
  } catch (error) {
    console.error('Error updating device info:', error);
  }
};

// Main App component
export default function App(): JSX.Element | null {
  const [isFirebaseInitialized, setIsFirebaseInitialized] = useState<boolean>(false);

  useEffect(() => {
    const initializeFirebase = async () => {
      try {
        // Initialize Firebase only if not already initialized
        const app: FirebaseApp = initializeApp(firebaseConfig);
        
        // Initialize Realtime Database and Firestore
        const database: Database = getDatabase(app);
        const firestore: Firestore = getFirestore(app);

        console.log("Firebase has been successfully initialized.");

        const deviceId = await getDeviceId();  // Aquí estamos esperando la función 
        await sendInitialDeviceData(deviceId);

        setIsFirebaseInitialized(true);
      } catch (error) {
        console.error("Error initializing Firebase:", error);
      }
    };

    initializeFirebase();
  }, []);

  if (!isFirebaseInitialized) {
    return null; // Optionally, render a loading screen here
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar hidden={true} />
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
