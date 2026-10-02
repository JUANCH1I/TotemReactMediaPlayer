// Dims the television from the dashboard. The panel's backlight is the real
// control: it lowers the light the screen emits, saves power and keeps the
// picture's contrast. It is a vendor setting, though (`picture_backlight` in
// Settings.Global on the MediaTek televisions we use), written only with a
// permission granted per television over adb. Where it is missing, or the
// permission was never granted, the app lays a black veil over what it draws:
// the backlight stays on, but the screen at least looks dimmer to the room.
//
// Written against an injected native module so the decision can be tested
// without a television.

// The veil never goes fully black: a totem at brightness 0 would look switched
// off, and nobody in the room could tell a dimmed screen from a dead one. At
// 0.85 a fifth of the picture still shows through, enough to read it up close.
export const MAX_OVERLAY_OPACITY = 0.85

export function normalizeDashboardBrightness(value) {
  // The dashboard slider sends 0 to 100. Anything else means nobody asked, and
  // the television keeps whatever the remote control left it at.
  if (typeof value !== 'number' || !Number.isFinite(value)) return null

  return Math.round(Math.min(Math.max(value, 0), 100))
}

export function overlayOpacityFor(level) {
  if (level === null) return 0

  return Math.round(((100 - level) / 100) * MAX_OVERLAY_OPACITY * 1000) / 1000
}

// Returns the opacity of the veil the app has to draw: 0 when the backlight
// took the value, or when there is no value to apply.
export function applyPanelBrightness(kiosk, level, log = console.error) {
  if (level === null) return 0

  try {
    if (kiosk?.setBacklight?.(level) === true) return 0
  } catch (error) {
    log('Unable to set the panel backlight:', error)
  }

  return overlayOpacityFor(level)
}
