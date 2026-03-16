// tests/modules/gmail/classifier.test.js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)
process.env.ANTHROPIC_API_KEY = 'test-key'

const mockAsk = mock.fn(async () => '[]')
mock.module('../../../scripts/core/claude.js', {
  namedExports: { ask: mockAsk }
})

const { classify } = await import('../../../scripts/modules/gmail/classifier.js')

function makeEmail(overrides = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    subject: 'Test email',
    from: 'someone@example.com',
    snippet: 'Hello',
    date: new Date().toUTCString(),
    labelIds: ['INBOX'],
    hasAttachment: false,
    listUnsubscribeHeader: null,
    inReplyTo: null,
    ...overrides,
  }
}

beforeEach(() => mockAsk.mock.resetCalls())

describe('classifier.js — rule-based pass', () => {
  it('attachment is actionable (rule 1) regardless of label', async () => {
    const result = await classify([makeEmail({ hasAttachment: true, labelIds: ['CATEGORY_PROMOTIONS'] })])
    assert.equal(result.actionable.length, 1)
    assert.equal(result.deletable.length, 0)
    assert.equal(mockAsk.mock.calls.length, 0)
  })

  it('In-Reply-To header is actionable (rule 2)', async () => {
    const result = await classify([makeEmail({ inReplyTo: '<prev@example.com>' })])
    assert.equal(result.actionable.length, 1)
    assert.equal(mockAsk.mock.calls.length, 0)
  })

  it('CATEGORY_PROMOTIONS with no attachment is deletable (rule 3)', async () => {
    const result = await classify([makeEmail({ labelIds: ['CATEGORY_PROMOTIONS'] })])
    assert.equal(result.deletable.length, 1)
    assert.equal(mockAsk.mock.calls.length, 0)
  })

  it('CATEGORY_SOCIAL is deletable (rule 3)', async () => {
    const result = await classify([makeEmail({ labelIds: ['CATEGORY_SOCIAL'] })])
    assert.equal(result.deletable.length, 1)
  })

  it('List-Unsubscribe with no reply-to is deletable (rule 4)', async () => {
    const result = await classify([makeEmail({ listUnsubscribeHeader: '<mailto:u@s.com>' })])
    assert.equal(result.deletable.length, 1)
    assert.equal(mockAsk.mock.calls.length, 0)
  })

  it('attachment wins over CATEGORY_PROMOTIONS (rule 1 beats rule 3)', async () => {
    const result = await classify([makeEmail({ hasAttachment: true, labelIds: ['CATEGORY_PROMOTIONS'] })])
    assert.equal(result.actionable.length, 1)
    assert.equal(result.deletable.length, 0)
  })

  it('starred email is excluded from all results regardless of label', async () => {
    const result = await classify([makeEmail({ labelIds: ['STARRED', 'CATEGORY_PROMOTIONS'] })])
    assert.equal(result.actionable.length, 0)
    assert.equal(result.deletable.length, 0)
    assert.equal(result.orders.length, 0)
  })
})

describe('classifier.js — order age logic', () => {
  it('order < 24h is actionable', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toUTCString() // 1h ago
    mockAsk.mock.mockImplementationOnce(async () =>
      JSON.stringify([{ id: 'msg-1', label: 'order', reason: 'shipping' }])
    )
    const result = await classify([makeEmail({ id: 'msg-1', date: recent })])
    assert.equal(result.actionable.length, 1)
  })

  it('order 24h-90d is silently kept (not in any output list)', async () => {
    const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toUTCString() // 5 days ago
    mockAsk.mock.mockImplementationOnce(async () =>
      JSON.stringify([{ id: 'msg-1', label: 'order', reason: 'old' }])
    )
    const result = await classify([makeEmail({ id: 'msg-1', date: old })])
    assert.equal(result.actionable.length, 0)
    assert.equal(result.deletable.length, 0)
    assert.equal(result.orders.length, 0)
  })

  it('order >= 90d is deletable', async () => {
    const veryOld = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toUTCString()
    mockAsk.mock.mockImplementationOnce(async () =>
      JSON.stringify([{ id: 'msg-1', label: 'order', reason: 'very old receipt' }])
    )
    const result = await classify([makeEmail({ id: 'msg-1', date: veryOld })])
    assert.equal(result.deletable.length, 1)
  })
})

describe('classifier.js — Claude fallback', () => {
  it('ambiguous emails are sent to Claude', async () => {
    mockAsk.mock.mockImplementationOnce(async () =>
      JSON.stringify([{ id: 'msg-1', label: 'actionable', reason: 'direct email' }])
    )
    const result = await classify([makeEmail()])
    assert.equal(mockAsk.mock.calls.length, 1)
    assert.equal(result.actionable.length, 1)
  })

  it('Claude failure degrades gracefully — omits ambiguous emails, does not throw', async () => {
    mockAsk.mock.mockImplementationOnce(async () => { throw new Error('API error') })
    const result = await classify([makeEmail()])
    assert.equal(result.actionable.length, 0)
    assert.equal(result.deletable.length, 0)
  })

  it('skips Claude entirely when all emails matched rules', async () => {
    await classify([
      makeEmail({ labelIds: ['CATEGORY_PROMOTIONS'] }),
      makeEmail({ id: 'msg-2', hasAttachment: true }),
    ])
    assert.equal(mockAsk.mock.calls.length, 0)
  })
})
