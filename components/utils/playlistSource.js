// Where a screen reads its playlist from.
//
// A device can belong to a group. When it does, it plays the group's playlist
// instead of its own, so one dashboard change reaches every screen at once.
// Group inheritance applies to the plain MediaPlayer mode only: canvas cells
// keep reading the device's own dropzone playlists, because a canvas layout is
// per device and a group playlist has no notion of dropzones.

// Group ids are RTDB push ids or dashboard-chosen slugs; anything else is
// refused so a corrupt value can never become part of a database path.
const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function normalizeGroupId(value) {
  if (typeof value !== 'string') return null

  return GROUP_ID_PATTERN.test(value) ? value : null
}

export function resolvePlaylistSource({
  deviceId,
  groupId = null,
  canvaMode = false,
  dropzoneIndex,
}) {
  if (canvaMode) {
    return {
      kind: 'canvas',
      groupId: null,
      // A canvas cell without a dropzone has nothing to subscribe to; the
      // manifest key still exists so the shape stays uniform for callers.
      path:
        dropzoneIndex === undefined
          ? null
          : `devices/${deviceId}/playlistCanvas/${dropzoneIndex}`,
      manifestKey: `${deviceId}|playlistCanvas|${dropzoneIndex}`,
    }
  }

  const validGroupId = normalizeGroupId(groupId)
  if (validGroupId !== null) {
    return {
      kind: 'group',
      groupId: validGroupId,
      path: `groups/${validGroupId}/playlist`,
      // The device id stays in the key so two screens sharing a disk image
      // never read each other's cache, and the group id keeps a screen that
      // moves between groups from replaying the previous group's content.
      manifestKey: `${deviceId}|group|${validGroupId}`,
    }
  }

  return {
    kind: 'device',
    groupId: null,
    path: `devices/${deviceId}/playlist`,
    manifestKey: `${deviceId}|playlist`,
  }
}
