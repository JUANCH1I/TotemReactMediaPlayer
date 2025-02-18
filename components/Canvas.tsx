import React, { useState, useEffect } from 'react';
import { View, StyleSheet, Dimensions, Text } from 'react-native';
import { getDatabase, ref, onValue } from 'firebase/database';
import MediaPlayer from './MediaPlayer';
import TimeWeather from './TimeWeatherScreen';
import Carousel from './Carousel';
import * as Font from 'expo-font'
import { getDeviceId } from './utils/deviceId';

const { width, height } = Dimensions.get('window');

interface ComponentConfig {
  type: 'video' | 'weather' | 'image' | 'text' | 'carrusel';
  position: number;
  content?: string;
}

interface TotemConfig {
  layout: {
    rows: number;
    cols: number;
  };
  components: ComponentConfig[];
  design: 'default' | 'modern' | 'classic';
}

const Canvas: React.FC = () => {
  const [config, setConfig] = useState<TotemConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [fontsLoaded] = Font.useFonts({
    'Times New Roman': require('../assets/fonts/TimesNewRoman.ttf'), // Coloca aquí la ruta correcta a la fuente
    Roboto: require('../assets/fonts/Roboto-Regular.ttf'), // Coloca aquí la ruta correcta a la fuente
  });

  useEffect(() => {
    const fetchDeviceId = async () => {
      try {
        const id = await getDeviceId();
        setDeviceId(id);
      } catch (error) {
        setError('Error al obtener el ID del dispositivo');
      }
    };

    fetchDeviceId();
  }, []);

  useEffect(() => {
    if (!deviceId) return;

    const db = getDatabase();
    const configRef = ref(db, `devices/${deviceId}/layout`);

    const unsubscribe = onValue(configRef, (snapshot) => {
      const data = snapshot.val();
      console.log('Config data:', data);
      if (data && isValidConfig(data)) {
        setConfig(data as TotemConfig);
      } else {
        setError('Configuración inválida o no encontrada para este dispositivo');
      }
    }, (error) => {
      setError(`Error al obtener la configuración: ${error.message}`);
    });

    return () => unsubscribe();
  }, [deviceId]);

  const isValidConfig = (data: any): data is TotemConfig => {
    return (
      data &&
      typeof data.layout === 'object' &&
      typeof data.layout.rows === 'number' &&
      typeof data.layout.cols === 'number' &&
      Array.isArray(data.components) &&
      typeof data.design === 'string'
    );
  };

  const renderComponent = (component: ComponentConfig, cellWidth: number, cellHeight: number) => {
    switch (component.type) {
      case 'video':
        return (
          <MediaPlayer
          width={cellWidth}
          height={cellHeight}
          canvaMode={true}
          dropzoneIndex={component.position} // Pasar el índice aquí
        />
        );
      case 'carrusel':
        return (
          <Carousel
          width={cellWidth}
          height={cellHeight}
          dropzoneIndex={component.position} // Pasar el índice aquí
        />
        );
      case 'image':
        return (
          <MediaPlayer
            width={cellWidth}
            height={cellHeight}
            canvaMode={true}
            dropzoneIndex={component.position} // Pasar el índice aquí
          />
        );
      case 'weather':
        return (
          <TimeWeather
            width={cellWidth}
            height={cellHeight}
            location={component.content}
          />
        );
      case 'text':
        return <Text style={[styles.text, getDesignStyles(config?.design)]}>{component.content}</Text>;
      default:
        return null;
    }
  };

  const getDesignStyles = (design?: string) => {
    switch (design) {
      case 'modern':
        return styles.modernDesign;
      case 'classic':
        return styles.classicDesign;
      default:
        return {};
    }
  };

  if (error) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (!config) {
    return (
      <View style={styles.container}>
        <Text style={styles.loadingText}>Cargando configuración...</Text>
      </View>
    );
  }

  const cellWidth = width / config.layout.cols;
  const cellHeight = height / config.layout.rows;

  return (
    <View style={[styles.container, getDesignStyles(config.design)]}>
      {config.components.map((component, index) => (
        <View
          key={index}
          style={[
            styles.cell,
            {
              width: cellWidth,
              height: cellHeight,
              left: (component.position % config.layout.cols) * cellWidth,
              top: Math.floor(component.position / config.layout.cols) * cellHeight,
            },
          ]}
        >
          {renderComponent(component, cellWidth, cellHeight)}
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
  },
  cell: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  text: {
    color: 'white',
    fontSize: 18,
    textAlign: 'center',
  },
  loadingText: {
    color: 'white',
    fontSize: 18,
    textAlign: 'center',
  },
  errorText: {
    color: 'red',
    fontSize: 18,
    textAlign: 'center',
  },
  modernDesign: {
    // Add modern design styles here
    fontFamily: 'Roboto',
    color: '#FFFFFF',
  },
  classicDesign: {
    // Add classic design styles here
    fontFamily: 'Times New Roman',
    color: '#F0F0F0',
  },
});

export default Canvas;