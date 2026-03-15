// scripts/core/telegram.js
import { run as dbRun, queryOne } from './db.js'
import { logger } from './logger.js'

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

/**
 * Send a message to the configured chat.
 * Always uses parse_mode='HTML' — callers must HTML-escape any untrusted content
 * (user input, API responses, file paths) before passing it here.
 * Safe characters: use &amp; for &, &lt; for <, &gt; for >
 */
export async function send(text) {
  return call('sendMessage', { chat_id: CHAT_ID(), text, parse_mode: 'HTML' })
}

/**
 * Send a reply to a specific message in the configured chat.
 * Always uses parse_mode='HTML' — same escaping rules as send().
 */
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

/**
 * Requests user confirmation for an action via Telegram buttons.
 *
 * @param {object} params - Configuration
 * @param {string} params.actionId - Unique identifier for this confirmation request
 * @param {string} params.description - Human-readable description of the action to confirm
 * @param {string} params.callbackModule - Module name to invoke when confirmed (e.g., 'sync-calendar')
 * @param {string} params.callbackAction - Function name to invoke in the module (e.g., 'syncNow')
 * @param {object} [params.callbackParams={}] - Parameters to pass to the callback function
 *
 * @returns {undefined} This function does not await the user response. The callback-handler
 * workflow processes the user's button press asynchronously and invokes the specified
 * callback module/action accordingly. Callers should not rely on await or return values.
 */
export async function requestConfirmation({ actionId, description, callbackModule, callbackAction, callbackParams = {} }) {
  const expiresAt = Math.floor(Date.now() / 1000) + 300
  try {
    dbRun(
      `INSERT INTO pending_confirmations (action_id, module, description, data, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(action_id) DO NOTHING`,
      [actionId, callbackModule, description, JSON.stringify({ callbackModule, callbackAction, callbackParams }), expiresAt]
    )
  } catch (err) {
    logger.error('telegram', 'requestConfirmation-db-failed', err.message)
    throw err
  }
  await sendWithButtons(`⚠️ Confirm action:\n${description}`, [[
    { text: '✅ Confirm', callback_data: `confirm_${actionId}` },
    { text: '❌ Cancel',  callback_data: `cancel_${actionId}` },
  ]])
}
