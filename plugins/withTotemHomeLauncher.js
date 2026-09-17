const { withAndroidManifest } = require('expo/config-plugins')

// Makes the player the home app, so a television boots straight into the totem
// and the home button on the remote returns to it instead of leaving for the
// Google TV launcher. This is separate from kiosk mode: it needs no device
// owner, and it is what keeps the screen on the content when somebody presses
// a button by accident.
const HOME_CATEGORIES = [
  'android.intent.category.HOME',
  'android.intent.category.DEFAULT',
]

module.exports = function withTotemHomeLauncher(config) {
  return withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0]
    const activity = application?.activity?.find(
      (entry) => entry.$['android:name'] === '.MainActivity'
    )

    if (!activity) {
      throw new Error('MainActivity was not found in the Android manifest')
    }

    const launcherFilter = activity['intent-filter']?.find((filter) =>
      filter.category?.some(
        (category) =>
          category.$['android:name'] === 'android.intent.category.LAUNCHER'
      )
    )

    if (!launcherFilter) {
      throw new Error('The launcher intent filter was not found')
    }

    launcherFilter.category = launcherFilter.category ?? []

    HOME_CATEGORIES.forEach((name) => {
      const present = launcherFilter.category.some(
        (category) => category.$['android:name'] === name
      )

      if (!present) {
        launcherFilter.category.push({ $: { 'android:name': name } })
      }
    })

    return modConfig
  })
}
