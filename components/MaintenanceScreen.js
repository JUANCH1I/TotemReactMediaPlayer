import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import Kiosk from '../modules/kiosk'

// The service screen an installer uses in front of the totem, with the remote.
//
// It exists because the system settings are drawn in the television's own
// orientation: on a totem mounted vertically they appear sideways, keyboard
// included. Everything here is drawn by the app, so it rotates with the rest
// of the content. That is only possible because the app is the device owner;
// Android does not let an ordinary app join a network since version 10.

const PALETTE = {
  base: '#24191C',
  deep: '#170F11',
  cream: '#F6ECE1',
  muted: '#C4A99B',
  honey: '#F2B441',
  ember: '#E8705A',
}

const KEY_ROWS = [
  'abcdefghij',
  'klmnopqrst',
  'uvwxyz0123',
  '456789.-_@',
  '!#$%&*+=?/',
]

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

// focusFirst matters more than it looks: a television screen that opens with
// nothing focused swallows every press of the remote.
const Key = ({ label, onPress, wide = false, tone = 'normal', size, focusFirst = false }) => (
  <Pressable
    accessibilityRole='button'
    accessibilityLabel={label}
    hasTVPreferredFocus={focusFirst}
    onPress={onPress}
    style={({ focused, pressed }) => [
      styles.key,
      {
        minWidth: wide ? size * 3.4 : size * 1.6,
        paddingVertical: size * 0.32,
        paddingHorizontal: size * 0.4,
        backgroundColor:
          focused || pressed
            ? tone === 'danger'
              ? PALETTE.ember
              : PALETTE.honey
            : PALETTE.deep,
      },
    ]}
  >
    {({ focused, pressed }) => (
      <Text
        style={[
          styles.keyLabel,
          {
            fontSize: size,
            color: focused || pressed ? PALETTE.base : PALETTE.cream,
          },
        ]}
      >
        {label}
      </Text>
    )}
  </Pressable>
)

// Without a code the screen is one press away from any guest with the remote.
// The default is the last four digits of the device code, which a technician
// can read off the pairing screen, and the dashboard can set another one per
// totem. Digits only: the device code is hexadecimal, and a keypad on a remote
// has no letters, so the letters in it could never be typed.
const defaultPin = (deviceId) =>
  String(deviceId ?? '')
    .replace(/\D/g, '')
    .slice(-4)
    .padStart(4, '0')

/**
 * @param {{
 *   deviceId?: string | null,
 *   pin?: string | null,
 *   rotation?: number,
 *   onClose: () => void,
 * }} props
 */
const MaintenanceScreen = ({ deviceId = null, pin = null, rotation = 0, onClose }) => {
  const { width, height } = useWindowDimensions()
  const angle = ((rotation || 0) % 360 + 360) % 360
  const isQuarterTurn = angle === 90 || angle === 270
  const frameWidth = isQuarterTurn ? height : width
  const frameHeight = isQuarterTurn ? width : height
  const shortSide = Math.min(frameWidth, frameHeight)

  const type = useMemo(
    () => ({
      title: clamp(Math.round(shortSide * 0.06), 20, 42),
      body: clamp(Math.round(shortSide * 0.035), 14, 24),
      key: clamp(Math.round(shortSide * 0.03), 12, 20),
    }),
    [shortSide]
  )

  const qrSide = clamp(Math.round(shortSide * 0.32), 140, 300)
  const [step, setStep] = useState('pin')
  const [typedPin, setTypedPin] = useState('')
  const [networks, setNetworks] = useState([])
  const [selected, setSelected] = useState(null)
  const [password, setPassword] = useState('')
  const [upperCase, setUpperCase] = useState(false)
  const [status, setStatus] = useState(null)
  const [currentNetwork, setCurrentNetwork] = useState(null)
  const [locked, setLocked] = useState(false)
  const [setupSession, setSetupSession] = useState(null)

  useEffect(() => {
    try {
      setLocked(Kiosk.isDeviceOwner())
    } catch (error) {
      setLocked(false)
    }
  }, [])

  // The way out of a locked totem, with nothing but the remote. Wireless
  // debugging turns itself off on every reboot, so a technician standing in
  // front of the screen cannot count on a cable or a command from outside.
  const release = useCallback(() => {
    try {
      Kiosk.releaseDevice()
      setLocked(false)
      setStatus('Pantalla liberada. El televisor vuelve a su menú normal.')
    } catch (error) {
      setStatus(`No se pudo liberar: ${String(error?.message ?? error)}`)
    }
  }, [])

  const readCurrentNetwork = useCallback(() => {
    try {
      setCurrentNetwork(Kiosk.currentNetwork())
    } catch (error) {
      setCurrentNetwork(null)
    }
  }, [])

  useEffect(readCurrentNetwork, [readCurrentNetwork])

  const scan = useCallback(() => {
    setStatus('Buscando redes…')

    try {
      Kiosk.grantWifiPermissions()
      const found = Kiosk.scanNetworks()
      setNetworks(found)
      setStatus(found.length ? null : 'No se encontró ninguna red.')
      setStep('networks')
    } catch (error) {
      setStatus(`No se pudo buscar redes: ${String(error?.message ?? error)}`)
    }
  }, [])

  const connect = useCallback(() => {
    if (!selected) return

    setStatus(`Conectando a ${selected.ssid}…`)
    setStep('overview')

    try {
      Kiosk.connect(selected.ssid, selected.secured ? password : null)
      // The join takes a moment, so the result is read back rather than
      // assumed from the call returning.
      setTimeout(() => {
        readCurrentNetwork()
        const network = Kiosk.currentNetwork()
        setStatus(
          network === selected.ssid
            ? `Conectado a ${network}.`
            : `No se pudo conectar a ${selected.ssid}. Revisa la clave.`
        )
      }, 6000)
    } catch (error) {
      setStatus(`No se pudo conectar: ${String(error?.message ?? error)}`)
    }

    setPassword('')
  }, [password, readCurrentNetwork, selected])

  // Configuring from a phone beats configuring with a remote: a real keyboard,
  // and a page that is readable however the totem is mounted.
  const startPhoneSetup = useCallback(() => {
    setStatus('Levantando la red del tótem…')

    Kiosk.startSetup()
      .then((session) => {
        setSetupSession(session)
        setStatus(null)
        setStep('phone')
      })
      .catch((error) => {
        setStatus(
          `Este televisor no puede crear su propia red: ${String(error?.message ?? error)}`
        )
      })
  }, [])

  const stopPhoneSetup = useCallback(() => {
    try {
      Kiosk.stopSetup()
    } catch (error) {
      console.error('Unable to stop the setup network:', error)
    }

    setSetupSession(null)
    readCurrentNetwork()
    setStep('overview')
  }, [readCurrentNetwork])

  const appendKey = (character) => setPassword((value) => value + character)

  const expectedPin = (pin ?? defaultPin(deviceId)).toString()

  const appendPin = (digit) => {
    const next = typedPin + digit

    if (next.length < expectedPin.length) {
      setTypedPin(next)
      return
    }

    if (next === expectedPin) {
      setTypedPin('')
      setStatus(null)
      setStep('overview')
      return
    }

    setTypedPin('')
    setStatus('Código incorrecto.')
  }

  const renderPin = () => (
    <View style={styles.block}>
      <Text style={[styles.title, { fontSize: type.title }]}>Código de servicio</Text>
      <Text
        style={[
          styles.password,
          { fontSize: type.title, marginTop: type.body * 0.6, letterSpacing: 10 },
        ]}
      >
        {'•'.repeat(typedPin.length) || '—'}
      </Text>

      {status ? (
        <Text style={[styles.status, { fontSize: type.body, marginTop: type.body * 0.5 }]}>
          {status}
        </Text>
      ) : null}

      <View style={[styles.row, { marginTop: type.body }]}>
        {[...'0123456789'].map((digit, index) => (
          <Key
            key={digit}
            label={digit}
            size={type.body}
            focusFirst={index === 0}
            onPress={() => appendPin(digit)}
          />
        ))}
      </View>

      <View style={[styles.row, { marginTop: type.body * 0.6 }]}>
        <Key label='Salir' onPress={onClose} wide tone='danger' size={type.body} />
      </View>
    </View>
  )

  const renderOverview = () => (
    <View style={styles.block}>
      <Text style={[styles.title, { fontSize: type.title }]}>Mantenimiento</Text>

      <View style={{ marginTop: type.body }}>
        <Text style={[styles.label, { fontSize: type.body * 0.8 }]}>Equipo</Text>
        <Text style={[styles.value, { fontSize: type.body }]}>{deviceId ?? '—'}</Text>

        <Text style={[styles.label, { fontSize: type.body * 0.8, marginTop: type.body * 0.7 }]}>
          Red conectada
        </Text>
        <Text style={[styles.value, { fontSize: type.body }]}>
          {currentNetwork ?? 'sin conexión'}
        </Text>
      </View>

      {status ? (
        <Text style={[styles.status, { fontSize: type.body, marginTop: type.body }]}>
          {status}
        </Text>
      ) : null}

      <View style={[styles.row, { marginTop: type.body * 1.2 }]}>
        <Key label='Configurar desde el celular' onPress={startPhoneSetup} wide size={type.body} focusFirst />
        <Key label='Configurar acá' onPress={scan} wide size={type.body} />
        {locked ? (
          <Key label='Liberar pantalla' onPress={release} wide size={type.body} />
        ) : null}
        <Key label='Salir' onPress={onClose} wide tone='danger' size={type.body} />
      </View>
    </View>
  )

  const renderNetworks = () => (
    <View style={styles.block}>
      <Text style={[styles.title, { fontSize: type.title }]}>Elige una red</Text>

      <ScrollView style={{ maxHeight: frameHeight * 0.55, marginTop: type.body }}>
        {networks.map((network, index) => (
          <Pressable
            key={`${network.ssid}-${index}`}
            accessibilityRole='button'
            hasTVPreferredFocus={index === 0}
            onPress={() => {
              setSelected(network)
              setPassword('')
              setStep(network.secured ? 'password' : 'confirm')
            }}
            style={({ focused }) => [
              styles.networkRow,
              {
                paddingVertical: type.body * 0.45,
                paddingHorizontal: type.body * 0.6,
                backgroundColor: focused ? PALETTE.honey : 'transparent',
              },
            ]}
          >
            {({ focused }) => (
              <Text
                style={[
                  styles.value,
                  { fontSize: type.body, color: focused ? PALETTE.base : PALETTE.cream },
                ]}
              >
                {'▮'.repeat(Math.max(network.level, 1))}  {network.ssid}
                {network.secured ? '  🔒' : ''}
              </Text>
            )}
          </Pressable>
        ))}
      </ScrollView>

      <View style={[styles.row, { marginTop: type.body }]}>
        <Key label='Volver' onPress={() => setStep('overview')} wide size={type.body} focusFirst={networks.length === 0} />
      </View>
    </View>
  )

  const renderPhoneSetup = () => (
    <View style={styles.block}>
      <Text style={[styles.title, { fontSize: type.title }]}>Configurar desde el celular</Text>
      <Text
        style={[
          styles.value,
          { fontSize: type.body, marginTop: type.body * 0.5, maxWidth: frameWidth * 0.8 },
        ]}
      >
        1. Escanea el primer código para conectarte a la red del tótem.
        {'\n'}2. Escanea el segundo para abrir la página de configuración.
      </Text>

      <View style={[styles.row, { marginTop: type.body }]}>
        {setupSession?.joinQr ? (
          <View style={[styles.qrCard, { marginRight: type.body }]}>
            <Image
              source={{ uri: setupSession.joinQr }}
              style={{ width: qrSide, height: qrSide }}
            />
            <Text style={[styles.qrLabel, { fontSize: type.body * 0.75 }]}>
              Red {setupSession.ssid}
            </Text>
            <Text style={[styles.qrCode, { fontSize: type.body * 0.75 }]}>
              {setupSession.password}
            </Text>
          </View>
        ) : null}

        {setupSession?.pageQr ? (
          <View style={styles.qrCard}>
            <Image
              source={{ uri: setupSession.pageQr }}
              style={{ width: qrSide, height: qrSide }}
            />
            <Text style={[styles.qrLabel, { fontSize: type.body * 0.75 }]}>Página</Text>
            <Text style={[styles.qrCode, { fontSize: type.body * 0.75 }]}>
              {setupSession.url}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.row, { marginTop: type.body }]}>
        <Key label='Terminar' onPress={stopPhoneSetup} wide size={type.body} focusFirst />
      </View>
    </View>
  )

  const renderPassword = () => (
    <View style={styles.block}>
      <Text style={[styles.title, { fontSize: type.title }]}>{selected?.ssid}</Text>
      <Text style={[styles.label, { fontSize: type.body * 0.8, marginTop: type.body * 0.4 }]}>
        Clave
      </Text>
      <Text style={[styles.password, { fontSize: type.body * 1.2 }]}>
        {password.length ? password : '—'}
      </Text>

      {KEY_ROWS.map((row, rowIndex) => (
        <View key={row} style={[styles.row, { marginTop: type.key * 0.4 }]}>
          {[...row].map((character) => {
            const label = upperCase ? character.toUpperCase() : character

            return (
              <Key
                key={character}
                label={label}
                size={type.key}
                focusFirst={rowIndex === 0 && character === 'a'}
                onPress={() => appendKey(label)}
              />
            )
          })}
        </View>
      ))}

      <View style={[styles.row, { marginTop: type.key * 0.8 }]}>
        <Key
          label={upperCase ? 'abc' : 'ABC'}
          size={type.key}
          wide
          onPress={() => setUpperCase((value) => !value)}
        />
        <Key label='Borrar' size={type.key} wide onPress={() => setPassword((v) => v.slice(0, -1))} />
        <Key label='Conectar' size={type.key} wide onPress={connect} />
        <Key label='Cancelar' size={type.key} wide tone='danger' onPress={() => setStep('networks')} />
      </View>
    </View>
  )

  const renderConfirm = () => (
    <View style={styles.block}>
      <Text style={[styles.title, { fontSize: type.title }]}>{selected?.ssid}</Text>
      <Text style={[styles.value, { fontSize: type.body, marginTop: type.body * 0.6 }]}>
        Esta red es abierta, no necesita clave.
      </Text>
      <View style={[styles.row, { marginTop: type.body }]}>
        <Key label='Conectar' size={type.body} wide focusFirst onPress={connect} />
        <Key label='Cancelar' size={type.body} wide tone='danger' onPress={() => setStep('networks')} />
      </View>
    </View>
  )

  return (
    <View
      style={[
        styles.screen,
        {
          width: frameWidth,
          height: frameHeight,
          transform: [{ rotate: `${angle}deg` }],
          top: (height - frameHeight) / 2,
          left: (width - frameWidth) / 2,
          padding: Math.round(shortSide * 0.06),
        },
      ]}
    >
      {step === 'pin' ? renderPin() : null}
      {step === 'overview' ? renderOverview() : null}
      {step === 'networks' ? renderNetworks() : null}
      {step === 'phone' ? renderPhoneSetup() : null}
      {step === 'password' ? renderPassword() : null}
      {step === 'confirm' ? renderConfirm() : null}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {
    position: 'absolute',
    backgroundColor: PALETTE.base,
    justifyContent: 'center',
  },
  block: {
    alignItems: 'flex-start',
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  title: {
    color: PALETTE.cream,
    fontFamily: 'Nunito-Bold',
  },
  label: {
    color: PALETTE.muted,
    fontFamily: 'Nunito-Regular',
  },
  value: {
    color: PALETTE.cream,
    fontFamily: 'Nunito-Regular',
  },
  password: {
    color: PALETTE.honey,
    fontFamily: 'Nunito-Bold',
    letterSpacing: 2,
  },
  status: {
    color: PALETTE.honey,
    fontFamily: 'Nunito-Regular',
  },
  networkRow: {
    borderRadius: 6,
  },
  qrCard: {
    backgroundColor: PALETTE.cream,
    borderRadius: 14,
    padding: 12,
    alignItems: 'center',
  },
  qrLabel: {
    color: PALETTE.base,
    fontFamily: 'Nunito-Regular',
    marginTop: 8,
    opacity: 0.7,
  },
  qrCode: {
    color: PALETTE.base,
    fontFamily: 'Nunito-Bold',
  },
  key: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    margin: 3,
  },
  keyLabel: {
    fontFamily: 'Nunito-Bold',
  },
})

export default MaintenanceScreen
