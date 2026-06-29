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

const HEARTBEAT_MS = 30000 // late cada 30s para que el dashboard sepa que está vivo

/**
 * Observabilidad y control remoto del totem (bloque 2):
 * - Heartbeat: escribe status/lastSeen para saber qué totems están vivos.
 * - onDisconnect: marca offline automáticamente al cortarse la conexión.
 * - Comandos remotos: el dashboard escribe en devices/{id}/command y la app
 *   reacciona (reload, restart, checkUpdate). La rotación se controla aparte,
 *   por la prop `rotation` (rotación por software, NUNCA ADB).
 */
export function useDeviceMonitor() {
  useEffect(() => {
    let cancelled = false
    let heartbeatTimer = null
    let unsubscribeCommand = null

    const setup = async () => {
      const id = await getDeviceId()
      if (cancelled) return
      const db = getDatabase()
      const deviceRef = ref(db, `devices/${id}`)
      const statusRef = ref(db, `devices/${id}/status`)
      const commandRef = ref(db, `devices/${id}/command`)

      // Heartbeat periódico.
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
        const command = snapshot.val()
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

async function executeCommand(command) {
  const action = typeof command === 'string' ? command : command?.action
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
    console.warn('[deviceMonitor] error ejecutando comando:', action, err?.message)
  }
}
