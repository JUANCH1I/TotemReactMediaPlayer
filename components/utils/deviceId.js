import * as FileSystem from 'expo-file-system'

const filePath = `${FileSystem.documentDirectory}deviceId.txt`

export const getDeviceId = async () => {
  try {
    // Verificar si el archivo con el ID ya existe
    const fileInfo = await FileSystem.getInfoAsync(filePath)

    if (fileInfo.exists) {
      // Leer el ID si ya existe
      const id = await FileSystem.readAsStringAsync(filePath)
      return id
    } else {
      // Generar un nuevo ID y guardarlo
      const newId = 'device-' + Math.random().toString(36).substr(2, 9)
      await FileSystem.writeAsStringAsync(filePath, newId)
      return newId
    }
  } catch (error) {
    console.error('Error getting or creating device ID:', error)
    return 'device-fallback-' + Math.random().toString(36).substr(2, 9)
  }
}
