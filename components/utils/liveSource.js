// What the dashboard wrote under devices/{id}/live, checked before it reaches
// the player. A live stream URL is pasted by a person, so anything that is not
// an https address of sane length is treated as "no broadcast" rather than
// handed to the native player to choke on.

export const MAX_LIVE_URL_LENGTH = 4096
// Where the totem goes back to when the broadcast ends or is given up on.
export const LIVE_RETURN_SCREENS = Object.freeze([
  'MediaPlayer',
  'TimeWeather',
  'Canvas',
  'YoutubePlayer',
])
export const DEFAULT_RETURN_SCREEN = 'MediaPlayer'

const LIVE_URL_PATTERN = /^https:\/\/[^\s]+$/

export function normalizeReturnScreen(value) {
  return typeof value === 'string' && LIVE_RETURN_SCREENS.includes(value)
    ? value
    : DEFAULT_RETURN_SCREEN
}

export function normalizeLiveSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const url = value.url
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    url.length > MAX_LIVE_URL_LENGTH ||
    !LIVE_URL_PATTERN.test(url)
  ) {
    return null
  }

  // The extension is not enforced: HLS manifests routinely sit behind query
  // strings or signed paths, and the player reports an unplayable URL anyway.
  return { url, returnTo: normalizeReturnScreen(value.returnTo) }
}
