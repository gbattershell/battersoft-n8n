// tests/modules/gmail/gmail-client.test.js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)
process.env.GOOGLE_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'

const mockSetCredentials = mock.fn()
const mockTokensHandler = { fn: null }
const mockMessagesList = mock.fn(async () => ({
  data: { messages: [{ id: 'msg1', threadId: 'thread1' }] },
}))
const mockMessagesGet = mock.fn(async ({ id }) => ({
  data: {
    id,
    threadId: 'thread1',
    labelIds: ['INBOX'],
    snippet: 'Hello world',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Test email' },
        { name: 'From', value: 'sender@example.com' },
        { name: 'Date', value: 'Mon, 16 Mar 2026 10:00:00 +0000' },
      ],
      parts: [],
    },
  },
}))
const mockMessagesTrash = mock.fn(async () => ({ data: {} }))

mock.module('googleapis', {
  namedExports: {
    google: {
      auth: {
        OAuth2: class {
          constructor() {}
          setCredentials = mockSetCredentials
          on(event, fn) { if (event === 'tokens') mockTokensHandler.fn = fn }
        },
      },
      gmail: () => ({
        users: {
          messages: {
            list: mockMessagesList,
            get: mockMessagesGet,
            trash: mockMessagesTrash,
          },
        },
      }),
    },
  },
})

const { setSecret } = await import('../../../scripts/core/db.js')
setSecret('gmail_refresh_token', 'test-refresh-token')

const { listEmails, trashEmail, trashEmails } = await import('../../../scripts/modules/gmail/gmail-client.js')

beforeEach(() => {
  mockMessagesList.mock.resetCalls()
  mockMessagesGet.mock.resetCalls()
  mockMessagesTrash.mock.resetCalls()
})

describe('gmail-client.js', () => {
  it('listEmails returns an array of email objects with expected fields', async () => {
    const emails = await listEmails()
    assert.equal(emails.length, 1)
    assert.equal(emails[0].id, 'msg1')
    assert.equal(emails[0].subject, 'Test email')
    assert.equal(emails[0].from, 'sender@example.com')
    assert.equal(emails[0].snippet, 'Hello world')
    assert.equal(emails[0].hasAttachment, false)
    assert.equal(emails[0].listUnsubscribeHeader, null)
    assert.equal(emails[0].inReplyTo, null)
  })

  it('returns empty array when no messages', async () => {
    mockMessagesList.mock.mockImplementationOnce(async () => ({ data: {} }))
    const emails = await listEmails()
    assert.deepEqual(emails, [])
  })

  it('detects attachment by checking payload parts for non-empty filename', async () => {
    mockMessagesGet.mock.mockImplementationOnce(async ({ id }) => ({
      data: {
        id, threadId: 'thread1', labelIds: ['INBOX'], snippet: 'See attached',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'Subject', value: 'With attachment' },
            { name: 'From', value: 'a@b.com' },
            { name: 'Date', value: 'Mon, 16 Mar 2026 10:00:00 +0000' },
          ],
          parts: [
            { mimeType: 'text/plain', filename: '', headers: [] },
            { mimeType: 'application/pdf', filename: 'doc.pdf', headers: [] },
          ],
        },
      },
    }))
    const emails = await listEmails()
    assert.equal(emails[0].hasAttachment, true)
  })

  it('detects List-Unsubscribe header', async () => {
    mockMessagesGet.mock.mockImplementationOnce(async ({ id }) => ({
      data: {
        id, threadId: 'thread1', labelIds: ['CATEGORY_PROMOTIONS'], snippet: 'Sale',
        payload: {
          mimeType: 'text/html',
          headers: [
            { name: 'Subject', value: 'Big sale' },
            { name: 'From', value: 'promo@shop.com' },
            { name: 'Date', value: 'Mon, 16 Mar 2026 10:00:00 +0000' },
            { name: 'List-Unsubscribe', value: '<mailto:unsub@shop.com>' },
          ],
          parts: [],
        },
      },
    }))
    const emails = await listEmails()
    assert.ok(emails[0].listUnsubscribeHeader)
  })

  it('trashEmail calls Gmail trash API for one message', async () => {
    await trashEmail('msg1')
    assert.equal(mockMessagesTrash.mock.calls.length, 1)
    assert.equal(mockMessagesTrash.mock.calls[0].arguments[0].id, 'msg1')
  })

  it('trashEmails calls trash for each message and returns counts', async () => {
    await trashEmails(['msg1', 'msg2'])
    assert.equal(mockMessagesTrash.mock.calls.length, 2)
  })

  it('trashEmails returns { succeeded, failed } when some fail', async () => {
    mockMessagesTrash.mock.mockImplementationOnce(async () => { throw new Error('quota') })
    const result = await trashEmails(['fail-msg', 'ok-msg'])
    assert.equal(result.succeeded, 1)
    assert.equal(result.failed, 1)
  })
})
