// Keeps the television at the level the dashboard asked for. The remote control
// is the reason this exists: anybody can press volume down on a totem, and
// nothing in the app used to notice. The dashboard value is the intent, the
// device volume is the fact, and this reconciles them.
//
// Written against an injected native module so the behaviour can be tested
// without a television.

export const VOLUME_TOLERANCE = 0.02
export const REAPPLY_DELAY_MS = 1500

const clamp = (value) => Math.min(Math.max(value, 0), 1)

export function normalizeDashboardVolume(value) {
  // The dashboard slider sends 0 to 100.
  if (typeof value !== 'number' || !Number.isFinite(value)) return null

  return clamp(value / 100)
}

export function createSystemVolumeController({
  nativeModule,
  onReport = null,
  schedule = setTimeout,
  cancel = clearTimeout,
  reapplyDelayMs = REAPPLY_DELAY_MS,
  tolerance = VOLUME_TOLERANCE,
}) {
  let desired = null
  let subscription = null
  let pendingReapply = null
  let destroyed = false

  const report = (level) => {
    if (typeof onReport !== 'function') return

    try {
      onReport(level)
    } catch (error) {
      console.error('Unable to report system volume:', error)
    }
  }

  const applyDesired = () => {
    if (destroyed || desired === null) return

    try {
      const applied = nativeModule.setVolume(desired)
      report(typeof applied === 'number' ? applied : desired)
    } catch (error) {
      console.error('Unable to set system volume:', error)
    }
  }

  const clearPending = () => {
    if (pendingReapply === null) return

    cancel(pendingReapply)
    pendingReapply = null
  }

  // Someone moved the volume outside the app. Wait out the rest of their
  // button presses before correcting, so the level does not fight the remote
  // on every single step.
  const handleExternalChange = (level) => {
    if (destroyed || desired === null || typeof level !== 'number') return

    if (Math.abs(level - desired) <= tolerance) {
      clearPending()
      return
    }

    clearPending()
    pendingReapply = schedule(() => {
      pendingReapply = null
      applyDesired()
    }, reapplyDelayMs)
  }

  return {
    start() {
      if (destroyed || subscription) return

      try {
        subscription = nativeModule.addListener('onVolumeChange', (event) =>
          handleExternalChange(event?.volume)
        )
        nativeModule.startWatching()
      } catch (error) {
        console.error('Unable to observe system volume:', error)
      }
    },
    setDesiredVolume(level) {
      if (destroyed || level === null) return

      desired = clamp(level)
      clearPending()
      applyDesired()
    },
    getDesiredVolume() {
      return desired
    },
    destroy() {
      destroyed = true
      clearPending()

      try {
        subscription?.remove?.()
        nativeModule.stopWatching()
      } catch (error) {
        console.error('Unable to stop observing system volume:', error)
      }

      subscription = null
    },
  }
}
