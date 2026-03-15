// scripts/system/callback-handler.js
// Called by n8n when a Telegram callback_query arrives (button press)
import { run as dbRun, queryOne } from '../core/db.js'
import { answerCallbackQuery, send } from '../core/telegram.js'
import { logger } from '../core/logger.js'

export async function handle(callbackQuery) {
  const { id: callbackQueryId, data } = callbackQuery

  if (!data?.startsWith('confirm_') && !data?.startsWith('cancel_')) {
    // Not our callback — ignore
    return
  }

  const isConfirm = data.startsWith('confirm_')
  const actionId = data.replace(/^(confirm|cancel)_/, '')

  const row = queryOne('SELECT * FROM pending_confirmations WHERE action_id = ?', [actionId])
  if (!row) {
    await answerCallbackQuery(callbackQueryId, 'Action expired or already handled.')
    return
  }

  // Delete the pending confirmation row
  dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [actionId])

  if (!isConfirm) {
    await answerCallbackQuery(callbackQueryId, 'Cancelled.')
    await send('Action cancelled.')
    return
  }

  // Execute the stored callback
  const { callbackModule, callbackAction, callbackParams } = JSON.parse(row.data)
  await answerCallbackQuery(callbackQueryId, 'Confirmed! Processing...')

  try {
    // Validate callbackModule is a safe identifier before using in dynamic import path.
    // callbackAction is a property key lookup (not a path), so prototype-chain properties
    // are blocked by the `typeof === 'function'` guard below — no regex needed there.
    if (!/^[a-z0-9-]+$/.test(callbackModule)) {
      throw new Error(`Invalid callbackModule identifier: '${callbackModule}'`)
    }
    const mod = await import(`../modules/${callbackModule}/index.js`)
    if (typeof mod[callbackAction] === 'function') {
      await mod[callbackAction](callbackParams)
    } else if (typeof mod.run === 'function') {
      await mod.run({ confirmedAction: callbackAction, confirmedParams: callbackParams })
    } else {
      throw new Error(`Module ${callbackModule} has no function '${callbackAction}' or 'run'`)
    }
    logger.info('callback-handler', 'executed', `${callbackModule}.${callbackAction}`)
  } catch (err) {
    logger.error('callback-handler', 'execution-failed', err.message)
    await send(`❌ Error executing confirmed action: ${err.message}`)
  }
}
