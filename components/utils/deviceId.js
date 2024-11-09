import * as Application from 'expo-application'

export const getDeviceId = async () => {
  return Application.getAndroidId() // Solo en Android, único y persistente
}
