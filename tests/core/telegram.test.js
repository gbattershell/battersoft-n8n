// tests/core/telegram.test.js
// Tests mock the Telegram HTTP API — no real network calls made.
import { describe, it, mock, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_CHAT_ID = '12345'

// Capture all fetch calls
const fetchCalls = []
global.fetch = async (url, options) => {
  fetchCalls.push({ url, body: JSON.parse(options?.body || '{}') })
  return {
    ok: true,
    json: async () => ({ ok: true, result: { message_id: 1 } }),
  }
}

const { send, sendWithButtons, sendDigest, reply, requestConfirmation, answerCallbackQuery } = await import('../../scripts/core/telegram.js')

afterEach(() => { fetchCalls.length = 0 })

describe('telegram.js', () => {
  describe('send', () => {
    it('calls sendMessage with correct chat_id and text', async () => {
      await send('hello world')
      assert.equal(fetchCalls.length, 1)
      assert.match(fetchCalls[0].url, /sendMessage/)
      assert.equal(fetchCalls[0].body.chat_id, '12345')
      assert.equal(fetchCalls[0].body.text, 'hello world')
    })
  })

  describe('sendWithButtons', () => {
    it('includes reply_markup with inline_keyboard', async () => {
      const buttons = [[{ text: 'Yes', callback_data: 'yes' }]]
      await sendWithButtons('Choose:', buttons)
      const body = fetchCalls[0].body
      assert.deepEqual(body.reply_markup.inline_keyboard, buttons)
    })
  })

  describe('sendDigest', () => {
    it('formats sections into a single message', async () => {
      await sendDigest([
        { header: '📧 Email', items: ['1. Item one', '2. Item two'] },
        { header: '📅 Calendar', items: ['Meeting 3pm'] },
      ])
      const text = fetchCalls[0].body.text
      assert.match(text, /📧 Email/)
      assert.match(text, /Item one/)
      assert.match(text, /📅 Calendar/)
    })
  })

  describe('reply', () => {
    it('sends with reply_to_message_id', async () => {
      await reply(42, 'thanks')
      assert.equal(fetchCalls[0].body.reply_to_message_id, 42)
    })
  })

  describe('answerCallbackQuery', () => {
    it('calls answerCallbackQuery with correct callback_query_id', async () => {
      await answerCallbackQuery('cq-id-123', 'done')
      assert.match(fetchCalls[0].url, /answerCallbackQuery/)
      assert.equal(fetchCalls[0].body.callback_query_id, 'cq-id-123')
      assert.equal(fetchCalls[0].body.text, 'done')
    })
  })

  describe('requestConfirmation', () => {
    it('stores row in pending_confirmations and sends buttons', async () => {
      const { queryOne } = await import('../../scripts/core/db.js')
      await requestConfirmation({
        actionId: 'test_action_123',
        description: 'Delete 5 emails',
        callbackModule: 'gmail',
        callbackAction: 'deleteEmails',
        callbackParams: { ids: [1, 2, 3] },
      })
      // Check DB row was inserted
      const row = queryOne('SELECT * FROM pending_confirmations WHERE action_id = ?', ['test_action_123'])
      assert.ok(row)
      assert.equal(row.description, 'Delete 5 emails')
      const data = JSON.parse(row.data)
      assert.equal(data.callbackModule, 'gmail')
      assert.equal(data.callbackAction, 'deleteEmails')
      // expires_at should be approximately now + 300 seconds
      const nowSec = Math.floor(Date.now() / 1000)
      assert.ok(row.expires_at >= nowSec + 299 && row.expires_at <= nowSec + 301)
      // Check Telegram message was sent with buttons
      const body = fetchCalls[0].body
      assert.match(body.text, /Delete 5 emails/)
      assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, 'confirm_test_action_123')
      assert.equal(body.reply_markup.inline_keyboard[0][1].callback_data, 'cancel_test_action_123')
    })
  })
})
