import * as FileSystem from 'expo-file-system/legacy'

// How this totem is mounted, kept on the device itself.
//
// The dashboard owns the value, but a totem that only learns it from Firebase
// draws its first seconds sideways on every boot: the screen is up long before
// the network answers. So the last known orientation is written to disk and
// applied immediately, and the remote value corrects it when it arrives.

const FILE = `${FileSystem.documentDirectory ?? ''}orientation.json`
const VALID_ANGLES = [0, 90, 180, 270]

export function normalizeAngle(value) {
  // Absence is not zero: an empty value means nobody said how this screen is
  // mounted, while zero is a deliberate "horizontal".
  if (value === null || value === undefined || value === '') return null

  const angle = Number(value)

  if (!Number.isFinite(angle)) return null

  const normalized = ((Math.round(angle) % 360) + 360) % 360

  return VALID_ANGLES.includes(normalized) ? normalized : null
}

export function createOrientationStore({ fileSystem = FileSystem, path = FILE } = {}) {
  return {
    async load() {
      try {
        const info = await fileSystem.getInfoAsync(path)
        if (!info?.exists) return null

        const raw = await fileSystem.readAsStringAsync(path)

        return normalizeAngle(JSON.parse(raw)?.rotation)
      } catch (error) {
        console.error('Unable to read the saved orientation:', error)
        return null
      }
    },
    async save(rotation) {
      const angle = normalizeAngle(rotation)
      if (angle === null) return false

      try {
        await fileSystem.writeAsStringAsync(path, JSON.stringify({ rotation: angle }))
        return true
      } catch (error) {
        console.error('Unable to store the orientation:', error)
        return false
      }
    },
  }
}

export default createOrientationStore()
