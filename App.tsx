import React, { useEffect, useState } from 'react';
import { StyleSheet, SafeAreaView, StatusBar } from 'react-native';
import { initializeApp, FirebaseApp } from 'firebase/app';
import { getDatabase, Database } from 'firebase/database';
import { getFirestore, Firestore } from 'firebase/firestore';
import AppNavigator from './components/AppNavigator';

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
