const { withAndroidManifest } = require('expo/config-plugins')

// A venue may run its streaming server on its own network with no TLS, and
// the player only accepts such plain-http urls towards private addresses
// (components/utils/privateNetwork.js). Android blocks cleartext by default,
// so the manifest has to allow it explicitly; everything else the app talks
// to (Firebase, R2) stays https.
function allowCleartext(manifest) {
  const application = manifest.manifest.application?.[0]
  if (!application) {
    throw new Error('The application element was not found in the Android manifest')
  }
  application.$ = application.$ ?? {}
  application.$['android:usesCleartextTraffic'] = 'true'
  return manifest
}

function withTotemCleartext(config) {
  return withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = allowCleartext(modConfig.modResults)
    return modConfig
  })
}

module.exports = withTotemCleartext
module.exports.allowCleartext = allowCleartext
