/**
 * The Firebase Realtime Database contract shared by the dashboard and the
 * totem. The dashboard writes configuration and control, the totem writes
 * state and telemetry; both read the same nodes, so this file names every
 * field either side depends on. It is types only: the runtime validators live
 * next to the code that uses them (utils/liveSource.js, utils/syncSchedule.js,
 * utils/playlistSource.js), and nothing here is imported at runtime.
 */

/**
 * Screens the navigator can show, by the names the dashboard writes to
 * devices/{id}/currentScreen. Mirrors SCREEN_NAMES in utils/screenNames.js,
 * which the navigator test keeps aligned with AppNavigator.
 */
export type ScreenName =
  | 'MediaPlayer'
  | 'TimeWeather'
  | 'Canvas'
  | 'Carousel'
  | 'Live'

/** Where a totem returns after a broadcast: any screen except Live itself. */
export type LiveReturnScreen = Exclude<ScreenName, 'Live'>

/** One playlist entry (video or image). */
export interface PlaylistItem {
  videoUrl: string
  /** Seconds. Images usually arrive as 0 and get the player default. */
  duration: number
  videoId?: string
  /** Video speed: one of 0.5, 0.75, 1, 1.25, 1.5, 2. Missing or invalid plays at 1. */
  playbackRate?: number
}

/** Playlists are RTDB collections: objects indexed by push key, never arrays. */
export type Playlist = Record<string, PlaylistItem>

/** Software rotation of the rendered content, applied by the app itself. */
export type Rotation = 0 | 90 | 180 | 270

/** A render crash captured by components/ErrorBoundary.js. */
export interface DeviceLastError {
  message: string
  stack: string
  /** Device time in ms. */
  at: number
}

/** devices/{id}/live, written by the dashboard to start or stop a broadcast. */
export interface LiveBroadcast {
  /** HLS manifest URL; https, or plain http on the venue's private network. */
  url: string
  /** Server time in ms when the broadcast (re)started; a new value reopens it. */
  startedAt?: number | null
  /** Screen restored when the broadcast ends or is given up on. */
  returnTo?: LiveReturnScreen
}

/** devices/{id}/location, written by non-TV builds only. */
export interface DeviceLocation {
  latitude: number
  longitude: number
}

// --- Canvas mode (grid of components), devices/{id}/layout ---

export type CanvasComponentType = 'video' | 'weather' | 'image' | 'text' | 'carrusel'

export interface CanvasComponentConfig {
  type: CanvasComponentType
  /** Cell index, row-major. */
  position: number
  content?: string
}

export interface CanvasLayout {
  rows: number
  cols: number
}

export interface CanvasConfig {
  layout: CanvasLayout
  components: CanvasComponentConfig[]
  design: 'default' | 'modern' | 'classic'
}

/**
 * devices/{deviceId}: one node per screen.
 */
export interface DeviceData {
  // --- Written by the totem: registration and presence ---
  model?: string | null
  brand?: string | null
  os_version?: string | null
  osVersion?: string | null
  appVersion?: string | null
  /** True while connected; the server flips it to false on disconnect. */
  online?: boolean
  isScreenOn?: boolean
  /** Server timestamp of the last heartbeat or the disconnect. */
  lastSeen?: number
  /** Server timestamp of the first connection after the app started. */
  bootedAt?: number
  lastError?: DeviceLastError
  location?: DeviceLocation | null

  // --- Written by the dashboard: configuration and control ---
  currentScreen?: ScreenName
  playlist?: Playlist
  /** One playlist per canvas dropzone, indexed by dropzone. */
  playlistCanvas?: Record<string, Playlist>
  layout?: CanvasConfig
  /** Dashboard slider value, 0 to 100; utils/systemVolumeController.js maps it to 0 to 1. */
  volume?: number
  rotation?: Rotation
  /** Group whose playlist replaces the device's own in MediaPlayer mode. */
  groupId?: string | null
  live?: LiveBroadcast | null
  /** Boot into the app and answer the Home key; on unless explicitly false. Device owner only. */
  homeEnabled?: boolean
  /** Lock the television to the app. Opt-in per totem; only honoured when the app is device owner. */
  kioskEnabled?: boolean
  /** Code that opens the service screen from the remote. */
  maintenancePin?: string | null
}

// --- groups/{groupId} ---

/** groups/{groupId}/sync, written by the dashboard. */
export interface GroupSync {
  enabled: boolean
  /** Server time in ms at which the cycle started at item 0. */
  anchor: number
}

export interface GroupData {
  name?: string
  playlist?: Playlist
  sync?: GroupSync | null
}

// --- users/{uid} ---

/** users/{uid}/liveConfig, read by the dashboard to publish a broadcast. */
export interface LiveConfig {
  hlsUrl: string
  whipUrl: string
  publishUser?: string
  publishPass?: string
}

export interface UserData {
  liveConfig?: LiveConfig
}

/** The whole database as both sides see it. */
export interface DatabaseSchema {
  devices: Record<string, DeviceData>
  groups: Record<string, GroupData>
  users: Record<string, UserData>
}
