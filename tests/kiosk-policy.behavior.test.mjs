import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Two flags decide whether a television boots into the totem and whether it
// is locked there. The cases that matter are a fresh install (must do
// nothing), a totem with no flags yet (boots into the app, never locks), and a
// native call failing halfway.

const loadPolicy = async () => {
  const url = new URL('../components/utils/kioskPolicy.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ console })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })

  await module.link(() => {
    throw new Error('The kiosk policy must not import anything')
  })
  await module.evaluate()

  return module.namespace
}

const createFakeKiosk = ({ failing = [] } = {}) => {
  const calls = []
  const method = (name) => () => {
    calls.push(name)
    if (failing.includes(name)) {
      throw new Error(`${name} failed`)
    }
  }

  return {
    calls,
    setAsHome: method('setAsHome'),
    clearHome: method('clearHome'),
    lock: method('lock'),
    unlock: method('unlock'),
  }
}

const policy = await loadPolicy()
// Objects born in the sandbox carry that realm's prototypes, which strict deep
// equality rejects; spreading rebuilds them here with the same own fields.
const resolveKioskActions = (input) => ({ ...policy.resolveKioskActions(input) })
const applyKioskActions = (...args) => [...policy.applyKioskActions(...args)]

// --- resolveKioskActions ---

assert.deepEqual(
  resolveKioskActions({ isDeviceOwner: false, homeEnabled: true, kioskEnabled: true }),
  { home: null, lock: null },
  'a player that does not own the device must not touch it',
)

assert.deepEqual(
  resolveKioskActions({ isDeviceOwner: undefined, homeEnabled: true, kioskEnabled: true }),
  { home: null, lock: null },
  'ownership must be exactly true, never assumed',
)

for (const homeEnabled of [undefined, null, true, 'yes', 1]) {
  assert.equal(
    resolveKioskActions({ isDeviceOwner: true, homeEnabled, kioskEnabled: false }).home,
    'set',
    `home is on by default (homeEnabled=${String(homeEnabled)})`,
  )
}

assert.equal(
  resolveKioskActions({ isDeviceOwner: true, homeEnabled: false, kioskEnabled: false }).home,
  'clear',
  'only an explicit false turns the home pin off',
)

assert.equal(
  resolveKioskActions({ isDeviceOwner: true, homeEnabled: true, kioskEnabled: true }).lock,
  'lock',
  'the lock is applied when the dashboard opted in',
)

for (const kioskEnabled of [undefined, null, false, 'true', 1]) {
  assert.equal(
    resolveKioskActions({ isDeviceOwner: true, homeEnabled: true, kioskEnabled }).lock,
    'unlock',
    `the lock is opt-in only (kioskEnabled=${String(kioskEnabled)})`,
  )
}

assert.deepEqual(
  resolveKioskActions({ isDeviceOwner: true, homeEnabled: false, kioskEnabled: true }),
  { home: 'clear', lock: 'lock' },
  'the two flags are independent',
)

// --- applyKioskActions ---

{
  const kiosk = createFakeKiosk()
  applyKioskActions(kiosk, { home: 'set', lock: 'lock' })
  assert.deepEqual(kiosk.calls, ['setAsHome', 'lock'], 'home goes on before the lock')
}

{
  const kiosk = createFakeKiosk()
  applyKioskActions(kiosk, { home: 'clear', lock: 'unlock' })
  assert.deepEqual(kiosk.calls, ['unlock', 'clearHome'], 'the lock comes off before home is cleared')
}

{
  const kiosk = createFakeKiosk()
  applyKioskActions(kiosk, { home: 'set', lock: 'unlock' })
  assert.deepEqual(kiosk.calls, ['unlock', 'setAsHome'], 'default state: boot into the app, no lock')
}

{
  const kiosk = createFakeKiosk()
  applyKioskActions(kiosk, { home: null, lock: null })
  assert.deepEqual(kiosk.calls, [], 'a no-op policy calls nothing')
}

{
  const kiosk = createFakeKiosk({ failing: ['setAsHome'] })
  const logged = []
  const applied = applyKioskActions(kiosk, { home: 'set', lock: 'lock' }, (...args) => logged.push(args))
  assert.deepEqual(kiosk.calls, ['setAsHome', 'lock'], 'a failing home pin does not skip the lock')
  assert.deepEqual(applied, ['lock'], 'only the calls that succeeded are reported as applied')
  assert.equal(logged.length, 1, 'the failure is logged once')
  assert.match(logged[0][0], /setAsHome/)
}

{
  const kiosk = createFakeKiosk({ failing: ['unlock'] })
  applyKioskActions(kiosk, { home: 'clear', lock: 'unlock' }, () => {})
  assert.deepEqual(kiosk.calls, ['unlock', 'clearHome'], 'a failing unlock does not skip clearing home')
}

console.log('Kiosk policy behavior checks passed.')
