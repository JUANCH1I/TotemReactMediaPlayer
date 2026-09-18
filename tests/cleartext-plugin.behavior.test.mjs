import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { allowCleartext } = require('../plugins/withTotemCleartext.js')

// The pure transform sets the attribute and keeps everything else intact.
const manifest = {
  manifest: {
    application: [{ $: { 'android:name': '.MainApplication' }, activity: [{ $: {} }] }],
  },
}
const result = allowCleartext(manifest)
assert.equal(result.manifest.application[0].$['android:usesCleartextTraffic'], 'true')
assert.equal(result.manifest.application[0].$['android:name'], '.MainApplication')
assert.equal(result.manifest.application[0].activity.length, 1)

assert.throws(() => allowCleartext({ manifest: {} }), /application element/)

// The plugin is registered so prebuild applies it.
const appJson = JSON.parse(readFileSync(path.join(here, '../app.json'), 'utf8'))
assert.ok(
  appJson.expo.plugins.includes('./plugins/withTotemCleartext'),
  'app.json must register ./plugins/withTotemCleartext'
)

console.log('Cleartext plugin behavior checks passed.')
