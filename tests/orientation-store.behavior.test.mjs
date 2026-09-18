import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// The orientation decides whether a vertical totem shows its first seconds
// sideways, so what matters here is that a bad value never reaches the screen
// and that a broken disk never stops the player.

const loadStore = async () => {
  const url = new URL('../components/utils/orientationStore.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ console })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })

  await module.link((specifier) => {
    if (!specifier.startsWith('expo-file-system')) {
      throw new Error(`Unexpected import: ${specifier}`)
    }

    const exports = { documentDirectory: 'file:///documents/' }

    return new vm.SyntheticModule(
      ['documentDirectory'],
      function () {
        this.setExport('documentDirectory', exports.documentDirectory)
      },
      { context, identifier: specifier }
    )
  })
  await module.evaluate()

  return module.namespace
}

const createFakeDisk = (initial = null) => {
  let content = initial

  return {
    get content() {
      return content
    },
    getInfoAsync: async () => ({ exists: content !== null }),
    readAsStringAsync: async () => content,
    writeAsStringAsync: async (_path, value) => {
      content = value
    },
  }
}

const { createOrientationStore, normalizeAngle } = await loadStore()

// Only the four angles a screen can actually be mounted at.
assert.equal(normalizeAngle(0), 0)
assert.equal(normalizeAngle(90), 90)
assert.equal(normalizeAngle(270), 270)
assert.equal(normalizeAngle(-90), 270, 'Negative angles wrap around')
assert.equal(normalizeAngle(450), 90, 'Angles past a full turn wrap around')
assert.equal(normalizeAngle(45), null, 'A screen is not mounted at 45 degrees')
assert.equal(normalizeAngle('vertical'), null)
assert.equal(normalizeAngle(null), null)

{
  // A totem remembers how it is mounted across a reboot.
  const disk = createFakeDisk()
  const store = createOrientationStore({ fileSystem: disk, path: 'orientation.json' })

  assert.equal(await store.load(), null, 'Nothing is assumed before it is set')

  assert.equal(await store.save(90), true)
  assert.equal(await store.load(), 90)

  assert.equal(await store.save(45), false, 'An impossible angle is refused')
  assert.equal(await store.load(), 90, 'and leaves the stored one alone')
}

{
  // A disk that fails must not take the player down: the totem simply falls
  // back to whatever the dashboard says.
  const brokenDisk = {
    getInfoAsync: async () => {
      throw new Error('no storage')
    },
    readAsStringAsync: async () => {
      throw new Error('no storage')
    },
    writeAsStringAsync: async () => {
      throw new Error('no storage')
    },
  }
  const store = createOrientationStore({ fileSystem: brokenDisk, path: 'orientation.json' })

  assert.equal(await store.load(), null)
  assert.equal(await store.save(90), false)
}

{
  // Corrupted content reads as nothing rather than throwing.
  const disk = createFakeDisk('{ not json')
  const store = createOrientationStore({ fileSystem: disk, path: 'orientation.json' })

  assert.equal(await store.load(), null)
}

console.log('Orientation store behavior checks passed.')
