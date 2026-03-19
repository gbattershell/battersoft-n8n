// scripts/system/telegram-router.js
// Long-polls Telegram getUpdates and routes messages to modules.
import { getPreference, setPreference, queryOne } from '../core/db.js'
import { logger } from '../core/logger.js'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID

if (!TOKEN || !ALLOWED_CHAT_ID) {
  logger.error('telegram-router', 'startup-failed', 'TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID not set')
  process.exit(1)
}

const BASE = `https://api.telegram.org/bot${TOKEN}`

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function handleUpdate(update) {
  if (update.message) {
    const message = update.message
    const chatId = String(message.chat?.id)

    // Validate ALLOWED_CHAT_ID on every message — skip silently if mismatch
    if (chatId !== String(ALLOWED_CHAT_ID)) {
      return
    }

    const text = (message.text || '').toLowerCase().trim()

    if (text === 'status') {
      const mod = await import('../modules/status/index.js')
      await mod.run({ message })
    } else if (text.startsWith('cal')) {
      const mod = await import('../modules/calendar/index.js')
      await mod.run({ message })
    } else if (text.startsWith('$')) {
      // Phase 3: tiller
    } else if (text.startsWith('gh')) {
      // Phase 5: github
    } else if (text.startsWith('news')) {
      // Phase 4: news
    } else {
      // Check for pending calendar edit-await before defaulting to gmail
      const editAwait = queryOne("SELECT * FROM pending_confirmations WHERE module = 'calendar' AND action_id LIKE 'cal_edit_await_%' AND expires_at > unixepoch() LIMIT 1")
      if (editAwait) {
        const mod = await import('../modules/calendar/index.js')
        await mod.run({ message, editAwait })
      } else {
        const mod = await import('../modules/gmail/index.js')
        await mod.run({ action: 'digest', message })
      }
    }
  } else if (update.callback_query) {
    const callbackQuery = update.callback_query
    const mod = await import('./callback-handler.js')
    await mod.handle(callbackQuery)
  }
}

async function start() {
  let offset = Number(getPreference('telegram_offset') ?? 0)

  logger.info('telegram-router', 'start', `polling from offset ${offset}`)

  while (true) {
    try {
      const params = new URLSearchParams({
        timeout: '25',
        allowed_updates: JSON.stringify(['message', 'callback_query']),
        offset: String(offset),
      })

      const res = await fetch(`${BASE}/getUpdates?${params}`)
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`getUpdates failed ${res.status}: ${text}`)
      }

      const data = await res.json()
      if (!data.ok) {
        throw new Error(`Telegram API error: ${JSON.stringify(data)}`)
      }

      for (const update of data.result) {
        try {
          await handleUpdate(update)
        } catch (err) {
          logger.error('telegram-router', 'update-handler-error', err.message)
        }

        // Persist offset after EACH update
        offset = update.update_id + 1
        setPreference('telegram_offset', String(offset))
      }
    } catch (err) {
      logger.error('telegram-router', 'poll-error', err.message)
      await sleep(5000)
    }
  }
}

export { start }
