// scripts/system/confirm-timeout.js
import { query, run as dbRun } from '../core/db.js'
import { send } from '../core/telegram.js'
import { logger } from '../core/logger.js'

export async function cleanExpired() {
  const now = Math.floor(Date.now() / 1000)
  const expired = query(
    'SELECT * FROM pending_confirmations WHERE expires_at < ?',
    [now]
  )
  if (expired.length === 0) return

  for (const row of expired) {
    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [row.action_id])
    try {
      await send(`⏱ Action timed out (no response within 5 minutes):\n${row.description}`)
    } catch (err) {
      logger.error('confirm-timeout', 'send-failed', err.message)
    }
  }
}
