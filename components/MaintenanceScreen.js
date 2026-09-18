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
// included. Everything here is drawn by the app, so it rotates and re-flows
// with the rest of the content, and it is lit like the player rather than like
// a settings panel.
//
// The Wi-Fi parts only work when the app is the device owner: Android has not
// let an ordinary app join a network since version 10.

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

// Without a code the screen is one press away from any guest with the remote.
// The default is the last four digits of the device code, which a technician
// can read off the pairing screen, and the dashboard can set another one per
// totem. Digits only: the device code is hexadecimal and a remote has no
// letters, so its letters could never be typed.
const defaultPin = (deviceId) =>
  String(deviceId ?? '')
    .replace(/\D/g, '')
    .slice(-4)
    .padStart(4, '0')

const Key = ({
  label,
  onPress,
  size,
  wide = false,
  block = false,
  tone = 'normal',
  focusFirst = false,
}) => (
  <Pressable
    accessibilityRole='button'
    accessibilityLabel={label}
    hasTVPreferredFocus={focusFirst}
    onPress={onPress}
    style={({ focused, pressed }) => [
      styles.key,
      {
        minWidth: block ? '100%' : wide ? size * 3.6 : size * 1.7,
        paddingVertical: size * (block ? 0.55 : 0.34),
        paddingHorizontal: size * 0.5,
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
  // A vertical totem has room to stack and no room to spread.
  const stacked = frameWidth < frameHeight

  const type = useMemo(
    () => ({
      title: clamp(Math.round(shortSide * 0.062), 20, 44),
      body: clamp(Math.round(shortSide * 0.034), 14, 26),
      key: clamp(Math.round(shortSide * 0.028), 12, 22),
    }),
    [shortSide]
  )

  const padding = Math.round(shortSide * 0.08)
  const columnWidth = Math.min(frameWidth - padding * 2, 760)
  const qrSide = clamp(Math.round(shortSide * (stacked ? 0.3 : 0.28)), 130, 280)
  const glowSize = Math.round(Math.max(frameWidth, frameHeight) * 1.35)

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

  const expectedPin = (pin ?? defaultPin(deviceId)).toString()

  const readCurrentNetwork = useCallback(() => {
    try {
      setCurrentNetwork(Kiosk.currentNetwork())
    } catch (error) {
      setCurrentNetwork(null)
    }
  }, [])

  useEffect(readCurrentNetwork, [readCurrentNetwork])

  useEffect(() => {
    try {
      setLocked(Kiosk.isDeviceOwner())
    } catch (error) {
      setLocked(false)
    }
  }, [])

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
  // and a page that reads the same however the totem is mounted.
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

  const Title = ({ children }) => (
    <Text style={[styles.title, { fontSize: type.title }]}>{children}</Text>
  )

  const Line = ({ label, value }) => (
    <View style={{ marginTop: type.body * 0.8, alignItems: 'center' }}>
      <Text style={[styles.label, { fontSize: type.body * 0.8 }]}>{label}</Text>
      <Text style={[styles.value, { fontSize: type.body }]}>{value}</Text>
    </View>
  )

  const Status = () =>
    status ? (
      <Text
        style={[
          styles.status,
          { fontSize: type.body, marginTop: type.body, maxWidth: columnWidth },
        ]}
      >
        {status}
      </Text>
    ) : null

  const renderPin = () => (
    <>
      <Title>Código de servicio</Title>
      <Text style={[styles.pinDots, { fontSize: type.title, marginTop: type.body * 0.4 }]}>
        {'•'.repeat(typedPin.length) || '––––'}
      </Text>
      <Status />

      <View style={[styles.keys, { marginTop: type.body, maxWidth: columnWidth }]}>
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

      <View style={{ marginTop: type.body, width: columnWidth * 0.6 }}>
        <Key label='Salir' onPress={onClose} block tone='danger' size={type.body} />
      </View>
    </>
  )

  const renderOverview = () => (
    <>
      <Title>Mantenimiento</Title>
      <Line label='Equipo' value={deviceId ?? '—'} />
      <Line label='Red conectada' value={currentNetwork ?? 'sin conexión'} />
      <Status />

      <View style={{ marginTop: type.body * 1.4, width: columnWidth * 0.75 }}>
        <Key
          label='Configurar desde el celular'
          onPress={startPhoneSetup}
          block
          size={type.body}
          focusFirst
        />
        <Key label='Configurar aquí' onPress={scan} block size={type.body} />
        {locked ? (
          <Key label='Liberar pantalla' onPress={release} block size={type.body} />
        ) : null}
        <Key label='Salir' onPress={onClose} block tone='danger' size={type.body} />
      </View>
    </>
  )

  const renderNetworks = () => (
    <>
      <Title>Elige una red</Title>

      <ScrollView
        style={{ maxHeight: frameHeight * 0.5, marginTop: type.body, width: columnWidth }}
      >
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
                paddingVertical: type.body * 0.5,
                paddingHorizontal: type.body * 0.8,
                backgroundColor: focused ? PALETTE.honey : PALETTE.deep,
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

      <View style={{ marginTop: type.body, width: columnWidth * 0.6 }}>
        <Key
          label='Volver'
          onPress={() => setStep('overview')}
          block
          size={type.body}
          focusFirst={networks.length === 0}
        />
      </View>
    </>
  )

  const renderPassword = () => (
    <>
      <Title>{selected?.ssid}</Title>
      <Text style={[styles.label, { fontSize: type.body * 0.8, marginTop: type.body * 0.4 }]}>
        Clave
      </Text>
      <Text style={[styles.pinDots, { fontSize: type.body * 1.3 }]}>
        {password.length ? password : '––––'}
      </Text>

      <View style={{ marginTop: type.key, maxWidth: columnWidth }}>
        {KEY_ROWS.map((row, rowIndex) => (
          <View key={row} style={styles.keys}>
            {[...row].map((character) => {
              const label = upperCase ? character.toUpperCase() : character

              return (
                <Key
                  key={character}
                  label={label}
                  size={type.key}
                  focusFirst={rowIndex === 0 && character === 'a'}
                  onPress={() => setPassword((value) => value + label)}
                />
              )
            })}
          </View>
        ))}

        <View style={[styles.keys, { marginTop: type.key }]}>
          <Key
            label={upperCase ? 'abc' : 'ABC'}
            size={type.key}
            wide
            onPress={() => setUpperCase((value) => !value)}
          />
          <Key
            label='Borrar'
            size={type.key}
            wide
            onPress={() => setPassword((value) => value.slice(0, -1))}
          />
          <Key label='Conectar' size={type.key} wide onPress={connect} />
          <Key
            label='Cancelar'
            size={type.key}
            wide
            tone='danger'
            onPress={() => setStep('networks')}
          />
        </View>
      </View>
    </>
  )

  const renderConfirm = () => (
    <>
      <Title>{selected?.ssid}</Title>
      <Text
        style={[
          styles.value,
          { fontSize: type.body, marginTop: type.body * 0.6, maxWidth: columnWidth },
        ]}
      >
        Esta red es abierta, no necesita clave.
      </Text>

      <View style={{ marginTop: type.body, width: columnWidth * 0.6 }}>
        <Key label='Conectar' size={type.body} block focusFirst onPress={connect} />
        <Key
          label='Cancelar'
          size={type.body}
          block
          tone='danger'
          onPress={() => setStep('networks')}
        />
      </View>
    </>
  )

  const QrCard = ({ image, label, code }) => (
    <View style={[styles.qrCard, { padding: Math.round(qrSide * 0.07) }]}>
      <Image source={{ uri: image }} style={{ width: qrSide, height: qrSide }} />
      <Text style={[styles.qrLabel, { fontSize: type.body * 0.75 }]}>{label}</Text>
      <Text style={[styles.qrCode, { fontSize: type.body * 0.78 }]}>{code}</Text>
    </View>
  )

  const renderPhoneSetup = () => (
    <>
      <Title>Configurar desde el celular</Title>
      <Text
        style={[
          styles.value,
          { fontSize: type.body, marginTop: type.body * 0.6, maxWidth: columnWidth },
        ]}
      >
        Escanea el primero para entrar a la red del tótem, y el segundo para abrir la
        página.
      </Text>

      <View
        style={[
          styles.qrRow,
          { marginTop: type.body, flexDirection: stacked ? 'column' : 'row' },
        ]}
      >
        {setupSession?.joinQr ? (
          <QrCard
            image={setupSession.joinQr}
            label={`Red ${setupSession.ssid}`}
            code={setupSession.password}
          />
        ) : null}
        {setupSession?.pageQr ? (
          <QrCard image={setupSession.pageQr} label='Página' code={setupSession.url} />
        ) : null}
      </View>

      <View style={{ marginTop: type.body, width: columnWidth * 0.6 }}>
        <Key label='Terminar' onPress={stopPhoneSetup} block size={type.body} focusFirst />
      </View>
    </>
  )

  return (
    <View
      style={[
        styles.screen,
        {
          width: frameWidth,
          height: frameHeight,
          padding,
          transform: [{ rotate: `${angle}deg` }],
          top: (height - frameHeight) / 2,
          left: (width - frameWidth) / 2,
        },
      ]}
    >
      <Image
        pointerEvents='none'
        source={require('../assets/images/glow.png')}
        style={[
          styles.glow,
          {
            width: glowSize,
            height: glowSize,
            marginLeft: -glowSize / 2,
            marginTop: -glowSize / 2,
            tintColor: PALETTE.honey,
          },
        ]}
      />

      <View style={styles.column}>
        {step === 'pin' ? renderPin() : null}
        {step === 'overview' ? renderOverview() : null}
        {step === 'networks' ? renderNetworks() : null}
        {step === 'password' ? renderPassword() : null}
        {step === 'confirm' ? renderConfirm() : null}
        {step === 'phone' ? renderPhoneSetup() : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {
    position: 'absolute',
    backgroundColor: PALETTE.base,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    opacity: 0.14,
  },
  column: {
    alignItems: 'center',
  },
  keys: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  title: {
    color: PALETTE.cream,
    fontFamily: 'Nunito-Bold',
    textAlign: 'center',
  },
  label: {
    color: PALETTE.muted,
    fontFamily: 'Nunito-Regular',
    textAlign: 'center',
  },
  value: {
    color: PALETTE.cream,
    fontFamily: 'Nunito-Regular',
    textAlign: 'center',
  },
  pinDots: {
    color: PALETTE.honey,
    fontFamily: 'Nunito-Bold',
    letterSpacing: 8,
    textAlign: 'center',
  },
  status: {
    color: PALETTE.honey,
    fontFamily: 'Nunito-Regular',
    textAlign: 'center',
  },
  networkRow: {
    borderRadius: 12,
    marginBottom: 8,
  },
  key: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    margin: 5,
  },
  keyLabel: {
    fontFamily: 'Nunito-Bold',
    textAlign: 'center',
  },
  qrRow: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrCard: {
    backgroundColor: PALETTE.cream,
    borderRadius: 18,
    alignItems: 'center',
    margin: 8,
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
})

export default MaintenanceScreen
