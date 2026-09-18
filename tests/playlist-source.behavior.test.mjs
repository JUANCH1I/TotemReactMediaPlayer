import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// A group id ends up inside a database path and a cache key, so what matters
// here is that only a well-formed id can redirect a screen, and that canvas
// cells never follow a group.

async function loadModule() {
  const url = new URL('../components/utils/playlistSource.js', import.meta.url)
  const source = readFileSync(url, 'utf8')
  const context = vm.createContext({ RegExp })
  const module = new vm.SourceTextModule(source, { context, identifier: url.href })
  await module.link(() => {
    throw new Error('The playlist source resolver must stay free of runtime dependencies.')
  })
  await module.evaluate()
  return module.namespace
}

const plain = (value) => JSON.parse(JSON.stringify(value))

const { normalizeGroupId, resolvePlaylistSource } = await loadModule()

// Only push ids and simple slugs are accepted as group ids.
assert.equal(normalizeGroupId('-NxAbC_123'), '-NxAbC_123')
assert.equal(normalizeGroupId('lobby'), 'lobby')
assert.equal(normalizeGroupId('x'.repeat(128)), 'x'.repeat(128))
assert.equal(normalizeGroupId('x'.repeat(129)), null, 'Too long to be an id')
for (const invalid of [
  null,
  undefined,
  '',
  ' ',
  42,
  true,
  {},
  [],
  'has space',
  'a/b',
  'a.b',
  '$value',
  'ünïcode',
  'a\nb',
]) {
  assert.equal(normalizeGroupId(invalid), null, `Refused: ${JSON.stringify(invalid)}`)
}

{
  // A device without a group plays its own playlist, exactly as before.
  for (const groupId of [null, undefined, '', 'bad id', 'a/b']) {
    assert.deepEqual(
      plain(resolvePlaylistSource({ deviceId: 'dev-1', groupId })),
      {
        kind: 'device',
        groupId: null,
        path: 'devices/dev-1/playlist',
        manifestKey: 'dev-1|playlist',
      },
      `An unusable group id (${JSON.stringify(groupId)}) must not redirect the screen.`
    )
  }
}

{
  // A grouped device inherits the group playlist, cached under its own key.
  assert.deepEqual(
    plain(resolvePlaylistSource({ deviceId: 'dev-1', groupId: 'lobby' })),
    {
      kind: 'group',
      groupId: 'lobby',
      path: 'groups/lobby/playlist',
      manifestKey: 'dev-1|group|lobby',
    }
  )
  assert.notEqual(
    resolvePlaylistSource({ deviceId: 'dev-1', groupId: 'lobby' }).manifestKey,
    resolvePlaylistSource({ deviceId: 'dev-2', groupId: 'lobby' }).manifestKey,
    'Two screens in one group must not share a manifest key.'
  )
  assert.notEqual(
    resolvePlaylistSource({ deviceId: 'dev-1', groupId: 'lobby' }).manifestKey,
    resolvePlaylistSource({ deviceId: 'dev-1', groupId: 'bar' }).manifestKey,
    'Moving between groups must not replay the previous group from cache.'
  )
}

{
  // Canvas cells keep the device's own dropzone playlists even when grouped.
  assert.deepEqual(
    plain(
      resolvePlaylistSource({
        deviceId: 'dev-1',
        groupId: 'lobby',
        canvaMode: true,
        dropzoneIndex: 2,
      })
    ),
    {
      kind: 'canvas',
      groupId: null,
      path: 'devices/dev-1/playlistCanvas/2',
      manifestKey: 'dev-1|playlistCanvas|2',
    }
  )
  assert.equal(
    resolvePlaylistSource({ deviceId: 'dev-1', canvaMode: true }).path,
    null,
    'A canvas cell without a dropzone has nothing to subscribe to.'
  )
  assert.equal(
    resolvePlaylistSource({ deviceId: 'dev-1', canvaMode: true }).manifestKey,
    'dev-1|playlistCanvas|undefined',
    'The legacy canvas manifest key is preserved.'
  )
}

console.log('Playlist source behavior checks passed.')
