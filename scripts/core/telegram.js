// scripts/core/telegram.js
import { run as dbRun, queryOne } from './db.js'

const BASE = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`
const CHAT_ID = () => process.env.ALLOWED_CHAT_ID

async function call(method, body) {
  const res = await fetch(`${BASE()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Telegram ${method} failed ${res.status}: ${text}`)
  }
  return res.json()
}

export async function send(text) {
  return call('sendMessage', { chat_id: CHAT_ID(), text, parse_mode: 'HTML' })
}

export async function reply(messageId, text) {
  return call('sendMessage', {
    chat_id: CHAT_ID(),
    text,
    reply_to_message_id: messageId,
    parse_mode: 'HTML',
  })
}

export async function sendWithButtons(text, buttons) {
  return call('sendMessage', {
    chat_id: CHAT_ID(),
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  })
}

export async function sendDigest(sections) {
  const text = sections
    .map(s => `${s.header}\n${s.items.join('\n')}`)
    .join('\n\n')
  return send(text)
}

export async function answerCallbackQuery(callbackQueryId, text = '') {
  return call('answerCallbackQuery', { callback_query_id: callbackQueryId, text })
}

export async function requestConfirmation({ actionId, description, callbackModule, callbackAction, callbackParams = {} }) {
  const expiresAt = Math.floor(Date.now() / 1000) + 300
  dbRun(
    `INSERT INTO pending_confirmations (action_id, module, description, data, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(action_id) DO NOTHING`,
    [actionId, callbackModule, description, JSON.stringify({ callbackModule, callbackAction, callbackParams }), expiresAt]
  )
  await sendWithButtons(`⚠️ Confirm action:\n${description}`, [[
    { text: '✅ Confirm', callback_data: `confirm_${actionId}` },
    { text: '❌ Cancel',  callback_data: `cancel_${actionId}` },
  ]])
}
