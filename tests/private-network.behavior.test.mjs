import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '../components/utils/privateNetwork.js'), 'utf8')

const context = vm.createContext({})
const module = new vm.SourceTextModule(source, { context })
await module.link(() => {
  throw new Error('privateNetwork must not import anything')
})
await module.evaluate()
const { isPrivateIpv4, privateHttpHost, isAcceptableStreamUrl } = module.namespace

assert.equal(isPrivateIpv4('192.168.1.35'), true)
assert.equal(isPrivateIpv4('10.0.0.1'), true)
assert.equal(isPrivateIpv4('172.16.0.1'), true)
assert.equal(isPrivateIpv4('172.31.255.254'), true)
assert.equal(isPrivateIpv4('172.32.0.1'), false)
assert.equal(isPrivateIpv4('192.168.1.300'), false)
assert.equal(isPrivateIpv4('8.8.8.8'), false)
assert.equal(isPrivateIpv4('localhost'), false)
assert.equal(isPrivateIpv4(''), false)

assert.equal(privateHttpHost('http://192.168.1.35:8888/pantalla/index.m3u8'), '192.168.1.35')
assert.equal(privateHttpHost('http://10.1.2.3/live.m3u8?token=1'), '10.1.2.3')
assert.equal(privateHttpHost('http://example.com/live.m3u8'), null)
assert.equal(privateHttpHost('http://1.2.3.4:8888/x.m3u8'), null)
assert.equal(privateHttpHost('https://192.168.1.35/x.m3u8'), null)
assert.equal(privateHttpHost('http://192.168.1.35@evil.com/x'), null)
assert.equal(privateHttpHost('http://192.168.1.35:notaport/x'), null)

assert.equal(isAcceptableStreamUrl('https://live.example.com/pantalla/index.m3u8'), true)
assert.equal(isAcceptableStreamUrl('http://192.168.1.35:8888/pantalla/index.m3u8'), true)
assert.equal(isAcceptableStreamUrl('http://example.com/index.m3u8'), false)
assert.equal(isAcceptableStreamUrl('http://192.168.1.35/a b.m3u8'), false)
assert.equal(isAcceptableStreamUrl('ftp://192.168.1.35/x'), false)
assert.equal(isAcceptableStreamUrl(42), false)

console.log('Private network behavior checks passed.')
