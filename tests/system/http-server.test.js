// tests/system/http-server.test.js
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

let server, port

before(async () => {
  const mod = await import('../../scripts/system/http-server.js')

  mod.registerRoute('POST', '/test-route', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })

  mod.registerRoute('POST', '/test-error', async () => {
    throw new Error('handler exploded')
  })

  server = mod.startHttpServer(0) // port 0 = OS assigns random port
  await new Promise(resolve => server.once('listening', resolve))
  port = server.address().port
})

after(() => server.close())

async function post(path) {
  return fetch(`http://localhost:${port}${path}`, { method: 'POST' })
}

describe('http-server.js', () => {
  it('returns 200 for a registered route', async () => {
    const res = await post('/test-route')
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.ok, true)
  })

  it('returns 404 for unknown routes', async () => {
    const res = await post('/nonexistent')
    assert.equal(res.status, 404)
  })

  it('returns 500 when the handler throws', async () => {
    const res = await post('/test-error')
    assert.equal(res.status, 500)
    const json = await res.json()
    assert.ok(json.error.includes('exploded'))
  })

  it('ignores query string when matching routes', async () => {
    const res = await fetch(`http://localhost:${port}/test-route?foo=bar`, { method: 'POST' })
    assert.equal(res.status, 200)
  })
})
