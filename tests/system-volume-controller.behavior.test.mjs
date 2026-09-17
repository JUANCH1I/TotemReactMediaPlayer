import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// The controller is plain JavaScript around an injected native module, so the
// behaviour that matters — holding the level the dashboard asked for — is
// exercised here without a television.

const loadController = async () => {
  const url = new URL(
    '../components/utils/systemVolumeController.js',
    import.meta.url
  )
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ console, setTimeout, clearTimeout })
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: url.href,
  })

  await module.link(() => {
    throw new Error('The controller must not import anything')
  })
  await module.evaluate()

  return module.namespace
}

const createFakeDevice = (initial = 0.5) => {
  let level = initial
  let observing = false
  const listeners = new Set()

  return {
    get level() {
      return level
    },
    get observing() {
      return observing
    },
    // Simulates the remote control or anything else moving the volume.
    changeExternally(next) {
      level = next
      listeners.forEach((listener) => listener({ volume: next }))
    },
    module: {
      getVolume: () => level,
      setVolume: (next) => {
        level = next
        return next
      },
      startWatching: () => {
        observing = true
      },
      stopWatching: () => {
        observing = false
        listeners.clear()
      },
      addListener: (_event, listener) => {
        listeners.add(listener)
        return { remove: () => listeners.delete(listener) }
      },
    },
  }
}

const createManualClock = () => {
  const pending = new Map()
  let nextId = 1

  return {
    schedule: (callback, delay) => {
      const id = nextId++
      pending.set(id, { callback, delay })
      return id
    },
    cancel: (id) => pending.delete(id),
    get pendingCount() {
      return pending.size
    },
    runAll() {
      const entries = [...pending.entries()]
      pending.clear()
      entries.forEach(([, entry]) => entry.callback())
    },
  }
}

const { createSystemVolumeController, normalizeDashboardVolume } =
  await loadController()

// The dashboard slider speaks 0 to 100, the device speaks 0 to 1.
assert.equal(normalizeDashboardVolume(0), 0)
assert.equal(normalizeDashboardVolume(50), 0.5)
assert.equal(normalizeDashboardVolume(100), 1)
assert.equal(normalizeDashboardVolume(140), 1, 'Out of range values are clamped')
assert.equal(normalizeDashboardVolume(-20), 0)
assert.equal(normalizeDashboardVolume(null), null, 'A missing value is not a volume')
assert.equal(normalizeDashboardVolume('70'), null, 'A string is not a volume')

{
  // The dashboard value reaches the device.
  const device = createFakeDevice(0.2)
  const clock = createManualClock()
  const reported = []
  const controller = createSystemVolumeController({
    nativeModule: device.module,
    onReport: (level) => reported.push(level),
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  controller.start()
  assert.equal(device.observing, true, 'Starting must observe external changes')

  controller.setDesiredVolume(0.8)
  assert.equal(device.level, 0.8)
  assert.deepEqual(reported, [0.8], 'The applied level is reported back')

  controller.destroy()
  assert.equal(device.observing, false, 'Destroying must stop observing')
}

{
  // Somebody presses volume down on the remote: the totem restores the level,
  // but only after the presses stop.
  const device = createFakeDevice(0.5)
  const clock = createManualClock()
  const controller = createSystemVolumeController({
    nativeModule: device.module,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  controller.start()
  controller.setDesiredVolume(0.6)
  assert.equal(device.level, 0.6)

  device.changeExternally(0.4)
  assert.equal(device.level, 0.4, 'The correction is not immediate')
  assert.equal(clock.pendingCount, 1)

  device.changeExternally(0.3)
  assert.equal(
    clock.pendingCount,
    1,
    'Repeated presses must collapse into a single correction'
  )

  clock.runAll()
  assert.equal(device.level, 0.6, 'The dashboard level wins in the end')

  controller.destroy()
}

{
  // Our own write comes back through the observer and must not be corrected.
  const device = createFakeDevice(0.5)
  const clock = createManualClock()
  const controller = createSystemVolumeController({
    nativeModule: device.module,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  controller.start()
  controller.setDesiredVolume(0.7)
  device.changeExternally(0.7)

  assert.equal(clock.pendingCount, 0, 'No correction is scheduled for our own level')

  // A television with coarse steps lands close but not exactly on the value.
  device.changeExternally(0.71)
  assert.equal(clock.pendingCount, 0, 'A rounding difference is not a change')

  controller.destroy()
}

{
  // Nothing is enforced until the dashboard has actually said something.
  const device = createFakeDevice(0.5)
  const clock = createManualClock()
  const controller = createSystemVolumeController({
    nativeModule: device.module,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  controller.start()
  device.changeExternally(0.1)

  assert.equal(clock.pendingCount, 0, 'Without a desired level there is nothing to restore')
  assert.equal(device.level, 0.1)

  controller.destroy()
}

{
  // A failing native module must never take playback down with it.
  const clock = createManualClock()
  const brokenModule = {
    getVolume: () => {
      throw new Error('no audio service')
    },
    setVolume: () => {
      throw new Error('no audio service')
    },
    startWatching: () => {
      throw new Error('no audio service')
    },
    stopWatching: () => {},
    addListener: () => ({ remove: () => {} }),
  }
  const controller = createSystemVolumeController({
    nativeModule: brokenModule,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  controller.start()
  controller.setDesiredVolume(0.5)
  controller.destroy()
}

console.log('System volume controller behavior checks passed.')
