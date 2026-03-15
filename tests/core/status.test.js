// tests/core/status.test.js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_CHAT_ID = '12345'

const sentMessages = []
global.fetch = async (url, opts) => {
  sentMessages.push(JSON.parse(opts?.body || '{}'))
  return { ok: true, json: async () => ({ ok: true }) }
}

const { heartbeat, error: statusError, report } = await import('../../scripts/core/status.js')
const { getDb, queryOne, query } = await import('../../scripts/core/db.js')

// Clean relevant tables before each test
beforeEach(() => {
  getDb().exec('DELETE FROM module_status; DELETE FROM error_log')
  sentMessages.length = 0
})

describe('status.js', () => {
  describe('heartbeat', () => {
    it('creates a module_status row on first call', async () => {
      await heartbeat('hb-mod')
      const row = queryOne('SELECT * FROM module_status WHERE module = ?', ['hb-mod'])
      assert.ok(row)
      assert.equal(row.run_count, 1)
      assert.equal(row.consecutive_errors, 0)
    })

    it('increments run_count on subsequent calls', async () => {
      await heartbeat('hb-mod')
      await heartbeat('hb-mod')
      await heartbeat('hb-mod')
      const row = queryOne('SELECT run_count FROM module_status WHERE module = ?', ['hb-mod'])
      assert.equal(row.run_count, 3)
    })

    it('resets consecutive_errors and alert_sent_at to 0/NULL after errors', async () => {
      await statusError('hb-mod', new Error('oops'))
      await statusError('hb-mod', new Error('oops2'))
      await heartbeat('hb-mod')
      const row = queryOne('SELECT consecutive_errors, alert_sent_at FROM module_status WHERE module = ?', ['hb-mod'])
      assert.equal(row.consecutive_errors, 0)
      assert.equal(row.alert_sent_at, null)
    })
  })

  describe('error', () => {
    it('increments error_count and consecutive_errors', async () => {
      await statusError('fail-mod', new Error('test error'))
      const row = queryOne('SELECT * FROM module_status WHERE module = ?', ['fail-mod'])
      assert.equal(row.error_count, 1)
      assert.equal(row.consecutive_errors, 1)
    })

    it('inserts into error_log', async () => {
      await statusError('log-mod', new Error('logged error'))
      const rows = query('SELECT * FROM error_log WHERE module = ?', ['log-mod'])
      assert.equal(rows.length, 1)
      assert.equal(rows[0].message, 'logged error')
    })

    it('sends Telegram alert after 3 consecutive failures', async () => {
      await statusError('alert-mod', new Error('fail 1'))
      await statusError('alert-mod', new Error('fail 2'))
      await statusError('alert-mod', new Error('fail 3'))
      assert.equal(sentMessages.length, 1)
      assert.match(sentMessages[0].text, /alert-mod/)
      assert.match(sentMessages[0].text, /3 times/)
    })

    it('does not send a second alert within 24h cooldown (self-contained)', async () => {
      // Set up 3 failures to trigger first alert
      await statusError('cooldown-mod', new Error('fail 1'))
      await statusError('cooldown-mod', new Error('fail 2'))
      await statusError('cooldown-mod', new Error('fail 3'))
      assert.equal(sentMessages.length, 1, 'first alert fired')
      // 4th failure should NOT send another alert (cooldown active)
      await statusError('cooldown-mod', new Error('fail 4'))
      assert.equal(sentMessages.length, 1, 'no second alert within cooldown')
    })
  })

  describe('report', () => {
    it('returns header string when no modules registered', async () => {
      const text = await report()
      assert.match(text, /System Status/)
      assert.match(text, /No modules registered/)
    })

    it('shows gray square for a module with run_count 0 (pre-seeded row)', async () => {
      getDb().prepare("INSERT INTO module_status (module, run_count, error_count, consecutive_errors) VALUES ('unrun-mod', 0, 0, 0)").run()
      const text = await report()
      assert.match(text, /\u2b1c.*unrun-mod/)
    })

    it('shows checkmark for a module with no errors', async () => {
      await heartbeat('clean-mod')
      const text = await report()
      assert.match(text, /\u2705.*clean-mod/)
    })

    it('shows X for a module whose last run failed', async () => {
      await statusError('broken-mod', new Error('something broke'))
      const text = await report()
      assert.match(text, /\u274c.*broken-mod/)
    })

    it('shows warning for a module with past errors but last run succeeded', async () => {
      await statusError('warn-mod', new Error('old error'))
      await heartbeat('warn-mod') // last run succeeded
      const text = await report()
      assert.match(text, /\u26a0.*warn-mod/)
    })
  })
})
