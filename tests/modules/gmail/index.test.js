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
