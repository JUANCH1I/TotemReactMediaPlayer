// What a totem does with the television it owns, from two dashboard flags.
//
// Booting into the app and locking the television are different needs. A
// totem's purpose is to come up on its content, so the home pin is on unless
// the dashboard turns it off; it is recoverable from the remote's settings
// button, the service screen's release, or adb. The lock pins the screen to
// the app and can only be undone from the dashboard, the service screen or a
// factory reset, so it stays strictly opt-in. Nothing here runs when the app
// is not device owner: installing the player must never touch a television.

export function resolveKioskActions({ isDeviceOwner, homeEnabled, kioskEnabled }) {
  if (isDeviceOwner !== true) {
    return { home: null, lock: null }
  }

  return {
    home: homeEnabled === false ? 'clear' : 'set',
    lock: kioskEnabled === true ? 'lock' : 'unlock',
  }
}

// Order matters on the device: the home pin goes on before the lock so a
// locked screen always has the app behind it, and the lock comes off before
// the home pin is cleared so the television is never locked to a launcher
// that is no longer ours. Every call is guarded on its own: one native call
// failing must not skip the other.
export function applyKioskActions(kiosk, actions, log = console.error) {
  const steps = []

  if (actions.lock === 'lock') {
    if (actions.home) steps.push(actions.home === 'set' ? 'setAsHome' : 'clearHome')
    steps.push('lock')
  } else {
    if (actions.lock === 'unlock') steps.push('unlock')
    if (actions.home) steps.push(actions.home === 'set' ? 'setAsHome' : 'clearHome')
  }

  const applied = []

  for (const step of steps) {
    try {
      kiosk[step]()
      applied.push(step)
    } catch (error) {
      log(`Unable to apply the kiosk step ${step}:`, error)
    }
  }

  return applied
}
