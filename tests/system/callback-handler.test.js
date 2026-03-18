// tests/system/callback-handler.test.js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_CHAT_ID = '123'

const fetchMock = mock.fn(async () => ({ ok: true, json: async () => ({}) }))
global.fetch = fetchMock

const { handle } = await import('../../scripts/system/callback-handler.js')
const { getDb } = await import('../../scripts/core/db.js')

beforeEach(() => {
  getDb().prepare('DELETE FROM pending_confirmations').run()
  fetchMock.mock.resetCalls()
})

describe('callback-handler — module dispatch', () => {
  it('dispatches gmail_* callback data to gmail module handleCallback', async () => {
    let called = false
    mock.module('../../scripts/modules/gmail/index.js', {
      namedExports: {
        handleCallback: async () => { called = true },
      },
    })

    await handle({ id: 'cq1', data: 'gmail_skip_1741234567890' })
    assert.ok(called)
  })

  it('answers with error if module has no handleCallback export', async () => {
    mock.module('../../scripts/modules/nohandler/index.js', {
      namedExports: {},
    })

    await handle({ id: 'cq2', data: 'nohandler_action_123' })

    // fetch was called (answerCallbackQuery)
    assert.ok(fetchMock.mock.calls.length > 0)
  })

  it('ignores callback data with invalid module prefix (uppercase)', async () => {
    await handle({ id: 'cq3', data: 'INVALID_action' })
    // fetch called once for answerCallbackQuery
    assert.ok(fetchMock.mock.calls.length > 0)
  })
})
