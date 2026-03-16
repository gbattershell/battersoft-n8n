// tests/modules/gmail/index.test.js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_CHAT_ID = '123'
process.env.ANTHROPIC_API_KEY = 'test-key'

const fetchMock = mock.fn(async () => ({ ok: true, json: async () => ({}) }))
global.fetch = fetchMock

const mockListEmails = mock.fn(async () => [])
const mockTrashEmail = mock.fn(async () => {})
const mockTrashEmails = mock.fn(async () => ({ succeeded: 0, failed: 0 }))
mock.module('../../../scripts/modules/gmail/gmail-client.js', {
  namedExports: {
    listEmails: mockListEmails,
    trashEmail: mockTrashEmail,
    trashEmails: mockTrashEmails,
  },
})

const mockClassify = mock.fn(async () => ({ actionable: [], orders: [], deletable: [] }))
mock.module('../../../scripts/modules/gmail/classifier.js', {
  namedExports: { classify: mockClassify },
})

// Mock http-server to avoid side-effects from registerRoute
mock.module('../../../scripts/system/http-server.js', {
  namedExports: { registerRoute: () => {} },
})

const { run, handleCallback } = await import('../../../scripts/modules/gmail/index.js')
const { getDb, run: dbRun } = await import('../../../scripts/core/db.js')

function makeEmail(overrides = {}) {
  return {
    id: 'msg-1',
    subject: 'Test subject',
    from: 'Sender Name <sender@example.com>',
    snippet: 'Snippet',
    date: new Date().toUTCString(),
    labelIds: ['INBOX'],
    ...overrides,
  }
}

function getSendCalls() {
  return fetchMock.mock.calls.filter(c => String(c.arguments[0]).includes('sendMessage'))
}

beforeEach(() => {
  fetchMock.mock.resetCalls()
  mockListEmails.mock.resetCalls()
  mockClassify.mock.resetCalls()
  mockTrashEmails.mock.resetCalls()
  getDb().prepare('DELETE FROM pending_confirmations').run()
  getDb().prepare('DELETE FROM audit_log').run()
  getDb().prepare('DELETE FROM module_status').run()
})

describe('index.js — digest', () => {
  it('sends "Inbox clear" when no actionable emails or orders', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [makeEmail()])
    mockClassify.mock.mockImplementationOnce(async () => ({ actionable: [], orders: [], deletable: [] }))
    await run({ action: 'digest' })
    const text = JSON.parse(getSendCalls()[0].arguments[1].body).text
    assert.ok(text.includes('Inbox clear'))
  })

  it('digest includes actionable section', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [makeEmail()])
    mockClassify.mock.mockImplementationOnce(async () => ({
      actionable: [makeEmail({ subject: 'Meeting request', from: 'boss@work.com' })],
      orders: [],
      deletable: [],
    }))
    await run({ action: 'digest' })
    const text = JSON.parse(getSendCalls()[0].arguments[1].body).text
    assert.ok(text.includes('Actionable'))
    assert.ok(text.includes('Meeting request'))
  })

  it('digest includes orders section for recent orders', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [makeEmail()])
    mockClassify.mock.mockImplementationOnce(async () => ({
      actionable: [],
      orders: [makeEmail({ subject: 'Your order shipped' })],
      deletable: [],
    }))
    await run({ action: 'digest' })
    const text = JSON.parse(getSendCalls()[0].arguments[1].body).text
    assert.ok(text.includes('Orders') || text.includes('shipped'))
  })

  it('HTML-escapes subjects and sender names', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [makeEmail()])
    mockClassify.mock.mockImplementationOnce(async () => ({
      actionable: [makeEmail({ subject: '<b>xss</b>', from: 'A&B <a@b.com>' })],
      orders: [],
      deletable: [],
    }))
    await run({ action: 'digest' })
    const text = JSON.parse(getSendCalls()[0].arguments[1].body).text
    assert.ok(!text.includes('<b>xss</b>'))
    assert.ok(text.includes('&lt;b&gt;'))
    assert.ok(text.includes('A&amp;B'))
  })

  it('defaults to digest when no action provided', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [])
    mockClassify.mock.mockImplementationOnce(async () => ({ actionable: [], orders: [], deletable: [] }))
    await run({})
    assert.equal(mockListEmails.mock.calls.length, 1)
  })

  it('records heartbeat on success', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [])
    mockClassify.mock.mockImplementationOnce(async () => ({ actionable: [], orders: [], deletable: [] }))
    await run({ action: 'digest' })
    const status = getDb().prepare("SELECT * FROM module_status WHERE module = 'gmail'").get()
    assert.ok(status)
    assert.equal(status.consecutive_errors, 0)
  })
})

describe('index.js — deletion batch', () => {
  it('sends no message when no deletable emails exist', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [])
    mockClassify.mock.mockImplementationOnce(async () => ({ actionable: [], orders: [], deletable: [] }))
    await run({ action: 'deletion' })
    assert.equal(getSendCalls().length, 0)
  })

  it('sends deletion prompt with 3 buttons when deletable emails exist', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [makeEmail()])
    mockClassify.mock.mockImplementationOnce(async () => ({
      actionable: [], orders: [],
      deletable: [makeEmail(), makeEmail({ id: 'msg-2' })],
    }))
    await run({ action: 'deletion' })
    const call = getSendCalls()[0]
    const body = JSON.parse(call.arguments[1].body)
    const buttons = body.reply_markup.inline_keyboard[0].map(b => b.text)
    assert.ok(buttons.some(b => b.includes('Delete All')))
    assert.ok(buttons.some(b => b.includes('Review')))
    assert.ok(buttons.some(b => b.includes('Skip')))
  })

  it('stores message IDs in pending_confirmations', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [makeEmail()])
    mockClassify.mock.mockImplementationOnce(async () => ({
      actionable: [], orders: [],
      deletable: [makeEmail({ id: 'del-msg-1' })],
    }))
    await run({ action: 'deletion' })
    const row = getDb().prepare("SELECT data FROM pending_confirmations WHERE module = 'gmail'").get()
    assert.ok(row)
    const ids = JSON.parse(row.data)
    assert.ok(ids.includes('del-msg-1'))
  })
})

describe('index.js — handleCallback', () => {
  it('gmail_skip deletes the pending_confirmations row', async () => {
    const batchId = '9999'
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'gmail', 'test', ?, ?)",
      [batchId, JSON.stringify(['msg1']), Math.floor(Date.now() / 1000) + 300]
    )
    await handleCallback({ id: 'cq1', data: `gmail_skip_${batchId}` })
    const row = getDb().prepare('SELECT * FROM pending_confirmations WHERE action_id = ?').get(batchId)
    assert.equal(row, undefined)
  })

  it('gmail_delete_all trashes emails and sends confirmation', async () => {
    const batchId = '8888'
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'gmail', 'test', ?, ?)",
      [batchId, JSON.stringify(['msg1', 'msg2']), Math.floor(Date.now() / 1000) + 300]
    )
    mockTrashEmails.mock.mockImplementationOnce(async () => ({ succeeded: 2, failed: 0 }))
    await handleCallback({ id: 'cq1', data: `gmail_delete_all_${batchId}` })
    assert.equal(mockTrashEmails.mock.calls.length, 1)
    assert.ok(getSendCalls().length > 0)
  })
})
