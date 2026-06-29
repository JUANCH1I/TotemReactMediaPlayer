import { useEffect } from 'react'
import {
  getDatabase,
  ref,
  update,
  set,
  onValue,
  onDisconnect,
  serverTimestamp,
} from 'firebase/database'
import * as Updates from 'expo-updates'
import { getDeviceId } from './deviceId'
import { RemoteCommand } from '../types'

const HEARTBEAT_MS = 30000 // late cada 30s para que el dashboard sepa que está vivo

type CommandPayload = RemoteCommand | { action?: RemoteCommand } | null

/**
 * Observabilidad y control remoto del totem (bloque 2):
 * - Heartbeat: escribe status/lastSeen para saber qué totems están vivos.
 * - onDisconnect: marca offline automáticamente al cortarse la conexión.
 * - Comandos remotos: el dashboard escribe en devices/{id}/command y la app
 *   reacciona. La rotación se controla aparte (prop rotation, por software).
 */
export function useDeviceMonitor(): void {
  useEffect(() => {
    let cancelled = false
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    let unsubscribeCommand: (() => void) | null = null

    const setup = async () => {
      const id = await getDeviceId()
      if (cancelled) return
      const db = getDatabase()
      const deviceRef = ref(db, `devices/${id}`)
      const statusRef = ref(db, `devices/${id}/status`)
      const commandRef = ref(db, `devices/${id}/command`)

      const beat = () => {
        update(deviceRef, {
          status: 'online',
          lastSeen: serverTimestamp(),
        }).catch(() => {})
      }
      beat()
      heartbeatTimer = setInterval(beat, HEARTBEAT_MS)

      // Si el totem se desconecta (corte de red/energía), queda marcado offline.
      onDisconnect(statusRef).set('offline').catch(() => {})

      // Comandos remotos: se ejecutan una vez y se limpian para no repetirse.
      unsubscribeCommand = onValue(commandRef, (snapshot) => {
        const command = snapshot.val() as CommandPayload
        if (!command) return
        set(commandRef, null).catch(() => {})
        executeCommand(command)
      })
    }

    setup()

    return () => {
      cancelled = true
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (unsubscribeCommand) unsubscribeCommand()
    }
  }, [])
}

async function executeCommand(command: CommandPayload): Promise<void> {
  const action: RemoteCommand | undefined =
    typeof command === 'string' ? command : command?.action
  try {
    switch (action) {
      case 'reload':
      case 'restart':
        await Updates.reloadAsync()
        break
      case 'checkUpdate': {
        const result = await Updates.checkForUpdateAsync()
        if (result.isAvailable) {
          await Updates.fetchUpdateAsync()
          await Updates.reloadAsync()
        }
        break
      }
      default:
        console.warn('[deviceMonitor] comando desconocido:', action)
    }
  } catch (err) {
    console.warn(
      '[deviceMonitor] error ejecutando comando:',
      action,
      (err as Error)?.message
    )
  }
}
