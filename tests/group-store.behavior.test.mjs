import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// The stored group decides which cached manifest an offline boot replays, so
// what matters here is that a bad value never redirects the screen, that "no
// group" is remembered as firmly as a group, and that a broken disk never
// stops the player.

const loadStore = async () => {
  const url = new URL('../components/utils/groupStore.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ console, JSON, RegExp })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })

  await module.link((specifier) => {
    if (specifier === './playlistSource') {
      const sourceUrl = new URL('../components/utils/playlistSource.js', import.meta.url)
      return new vm.SourceTextModule(readFileSync(sourceUrl, 'utf8'), {
        context,
        identifier: sourceUrl.href,
      })
    }
    if (!specifier.startsWith('expo-file-system')) {
      throw new Error(`Unexpected import: ${specifier}`)
    }

    return new vm.SyntheticModule(
      ['documentDirectory'],
      function () {
        this.setExport('documentDirectory', 'file:///documents/')
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

const { createGroupStore } = await loadStore()

{
  // A totem remembers its group across a reboot, and remembers leaving it.
  const disk = createFakeDisk()
  const store = createGroupStore({ fileSystem: disk, path: 'group.json' })

  assert.equal(await store.load(), null, 'Nothing is assumed before it is set')

  assert.equal(await store.save('lobby'), true)
  assert.equal(await store.load(), 'lobby')

  assert.equal(await store.save('not a/valid id'), false, 'A malformed id is refused')
  assert.equal(await store.load(), 'lobby', 'and leaves the stored one alone')

  assert.equal(await store.save(undefined), false, 'Absence is not a decision')
  assert.equal(await store.load(), 'lobby')

  assert.equal(await store.save(null), true, 'Leaving the group is remembered')
  assert.equal(await store.load(), null)
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
  const store = createGroupStore({ fileSystem: brokenDisk, path: 'group.json' })

  assert.equal(await store.load(), null)
  assert.equal(await store.save('lobby'), false)
}

{
  // Corrupted or tampered content reads as nothing rather than throwing or
  // redirecting the screen.
  for (const content of ['{ not json', '{"groupId": "../devices"}', '{"groupId": 7}', '[]', 'null']) {
    const store = createGroupStore({ fileSystem: createFakeDisk(content), path: 'group.json' })
    assert.equal(await store.load(), null, `Refused: ${content}`)
  }
}

console.log('Group store behavior checks passed.')
