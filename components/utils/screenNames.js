// The screens the navigator can show, by the names the dashboard writes to
// devices/{id}/currentScreen. AppNavigator's frozen component map is the
// runtime source of truth; the navigator test checks that this list matches
// its keys, so pure modules (which cannot import React screens) can derive
// allowlists from it.
export const SCREEN_NAMES = Object.freeze([
  'MediaPlayer',
  'TimeWeather',
  'Canvas',
  'Carousel',
  'Live',
])

export const LIVE_SCREEN_NAME = 'Live'
