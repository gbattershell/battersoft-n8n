// scripts/system/callback-handler.js
// Called by n8n when a Telegram callback_query arrives (button press)
import { run as dbRun, queryOne } from '../core/db.js'
import { answerCallbackQuery, send } from '../core/telegram.js'
import { logger } from '../core/logger.js'

export async function handle(callbackQuery) {
  const { id: callbackQueryId, data } = callbackQuery

  if (data?.startsWith('confirm_') || data?.startsWith('cancel_')) {
    const isConfirm = data.startsWith('confirm_')
    const actionId = data.replace(/^(confirm|cancel)_/, '')

    const row = queryOne('SELECT * FROM pending_confirmations WHERE action_id = ?', [actionId])
    if (!row) {
      await answerCallbackQuery(callbackQueryId, 'Action expired or already handled.')
      return
    }

    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [actionId])

    if (!isConfirm) {
      await answerCallbackQuery(callbackQueryId, 'Cancelled.')
      await send('Action cancelled.')
      return
    }

    const { callbackModule, callbackAction, callbackParams } = JSON.parse(row.data)
    await answerCallbackQuery(callbackQueryId, 'Confirmed! Processing...')

    try {
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
    return
  }

  // Module-dispatched callback: data format is '<module>_<action>_<params>'
  // Extract module name from first '_'-delimited segment.
  const modulePrefix = data?.split('_')[0]
  if (!modulePrefix || !/^[a-z0-9-]+$/.test(modulePrefix)) {
    await answerCallbackQuery(callbackQueryId, 'Unknown action.')
    return
  }

  try {
    const mod = await import(`../modules/${modulePrefix}/index.js`)
    if (typeof mod.handleCallback !== 'function') {
      throw new Error(`Module '${modulePrefix}' has no handleCallback export`)
    }
    await mod.handleCallback(callbackQuery)
  } catch (err) {
    logger.error('callback-handler', 'module-dispatch-failed', err.message)
    await answerCallbackQuery(callbackQueryId, 'Error handling action.')
    await send(`❌ Callback error: ${err.message}`)
  }
}
