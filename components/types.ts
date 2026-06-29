/**
 * Contrato de datos entre el dashboard y el totem (Firebase Realtime Database).
 * Todo vive bajo `devices/{deviceId}`. Tipar este modelo blinda el punto más
 * frágil del sistema: el acoplamiento entre lo que el dashboard escribe y lo
 * que el totem lee.
 */

/** Pantallas que puede mostrar el totem (ver AppNavigator). */
export type ScreenName =
  | 'MediaPlayer'
  | 'TimeWeather'
  | 'Canvas'
  | 'Carousel'

/** Un elemento de la playlist (video o imagen). */
export interface PlaylistItem {
  videoUrl: string
  /** Duración en segundos. Las imágenes suelen venir en 0 (se usa el default). */
  duration: number
  videoId?: string
}

/** Rotación del contenido por software (NUNCA ADB). */
export type Rotation = 0 | 90 | 180 | 270

/** Comandos remotos que el dashboard escribe en devices/{id}/command. */
export type RemoteCommand = 'reload' | 'restart' | 'checkUpdate'

/** Error reportado por el ErrorBoundary para diagnóstico remoto. */
export interface DeviceLastError {
  message: string
  stack: string
  at: number
}

// --- Modo canvas (grid de componentes) ---

export type ComponentType = 'video' | 'weather' | 'image' | 'text' | 'carrusel'

export interface ComponentConfig {
  type: ComponentType
  position: number
  content?: string
}

export interface TotemLayout {
  rows: number
  cols: number
}

export interface TotemConfig {
  layout: TotemLayout
  components: ComponentConfig[]
  design: 'default' | 'modern' | 'classic'
}

/**
 * El nodo completo de un dispositivo: devices/{deviceId}.
 * Las colecciones (playlist, playlistCanvas) llegan como objetos indexados por
 * push-key de Firebase, no como arrays.
 */
export interface DeviceData {
  // --- Lo que ESCRIBE el totem (estado / telemetría) ---
  status?: 'online' | 'offline'
  lastSeen?: number
  lastError?: DeviceLastError
  isScreenOn?: boolean
  model?: string
  brand?: string
  os_version?: string
  location?: { latitude: number; longitude: number } | null

  // --- Lo que ESCRIBE el dashboard (configuración / control) ---
  currentScreen?: ScreenName
  playlist?: Record<string, PlaylistItem>
  playlistCanvas?: Record<string, Record<string, PlaylistItem>>
  volume?: number
  rotation?: Rotation
  command?: RemoteCommand
  layout?: TotemConfig
}
