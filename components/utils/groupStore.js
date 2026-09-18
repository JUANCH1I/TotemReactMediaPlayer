import * as FileSystem from 'expo-file-system/legacy'
import { normalizeGroupId } from './playlistSource'

// Which group this screen belongs to, kept on the device itself.
//
// The dashboard owns the value, but the playlist manifest is cached per source:
// a screen that boots offline without remembering its group would replay its
// own stale device playlist instead of the group's. So the last known group is
// written to disk and used to pick the manifest before the network answers.
// "No group" is stored too, so a screen removed from a group stays removed
// across a reboot.

const FILE = `${FileSystem.documentDirectory ?? ''}group.json`

export function createGroupStore({ fileSystem = FileSystem, path = FILE } = {}) {
  return {
    async load() {
      try {
        const info = await fileSystem.getInfoAsync(path)
        if (!info?.exists) return null

        const raw = await fileSystem.readAsStringAsync(path)

        return normalizeGroupId(JSON.parse(raw)?.groupId)
      } catch (error) {
        console.error('Unable to read the saved group:', error)
        return null
      }
    },
    async save(groupId) {
      const normalized = normalizeGroupId(groupId)
      // Only an explicit "none" clears the value; a corrupt id is ignored so it
      // cannot displace a good one.
      if (normalized === null && groupId !== null) return false

      try {
        await fileSystem.writeAsStringAsync(
          path,
          JSON.stringify({ groupId: normalized })
        )
        return true
      } catch (error) {
        console.error('Unable to store the group:', error)
        return false
      }
    },
  }
}

export default createGroupStore()
