// The pairing QR is needed exactly when a freshly installed totem has no network
// yet, so a remote image service can never be the only source. The native kiosk
// module can draw the code on device; until it is exposed to JS the remote
// endpoint stays as the fallback for an already-connected screen.
export const REMOTE_QR_ENDPOINT = 'https://api.qrserver.com/v1/create-qr-code/'
export const DEFAULT_QR_SIZE = 150

export function buildRemoteQrUrl(deviceId, size = DEFAULT_QR_SIZE) {
  return `${REMOTE_QR_ENDPOINT}?size=${size}x${size}&data=${encodeURIComponent(
    deviceId
  )}`
}

export async function resolveDeviceQrSource(
  deviceId,
  { generateLocalQr = null, size = DEFAULT_QR_SIZE } = {}
) {
  if (typeof deviceId !== 'string' || deviceId.length === 0) return null

  if (typeof generateLocalQr === 'function') {
    try {
      const localUri = await generateLocalQr(deviceId, size)
      if (typeof localUri === 'string' && localUri.length > 0) {
        return { uri: localUri, isLocal: true }
      }
    } catch (error) {
      // A generator fault must not cost the screen its QR on a device that does
      // have network, so the remote endpoint still gets its turn.
      console.error('Local QR generation failed:', error)
    }
  }

  return { uri: buildRemoteQrUrl(deviceId, size), isLocal: false }
}
