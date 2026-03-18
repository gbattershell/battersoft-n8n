// scripts/modules/gmail/index.js
import { heartbeat, error as statusError } from '../../core/status.js'
import { logger } from '../../core/logger.js'
import { auditLog, run as dbRun, queryOne } from '../../core/db.js'
import { send, sendWithButtons, answerCallbackQuery } from '../../core/telegram.js'
import { registerRoute } from '../../system/http-server.js'
import { listEmails, trashEmail, trashEmails } from './gmail-client.js'
import { classify } from './classifier.js'

// Register HTTP routes for n8n scheduled triggers
registerRoute('POST', '/gmail/digest', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  run({ action: 'digest' }).catch(err => logger.error('gmail', 'http-digest-error', err.message))
})

registerRoute('POST', '/gmail/deletion', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  run({ action: 'deletion' }).catch(err => logger.error('gmail', 'http-deletion-error', err.message))
})

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function senderName(from) {
  return esc(from.replace(/<[^>]+>/g, '').trim() || from)
}

function formatAge(dateStr) {
  if (!dateStr) return ''
  const ms = Date.now() - Date.parse(dateStr)
  if (isNaN(ms) || ms < 0) return ''
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return '(just now)'
  if (h < 24) return `(${h}h ago)`
  return `(${Math.floor(h / 24)}d ago)`
}

async function runDigest() {
  const rawEmails = await listEmails()
  const { actionable, orders, deletable } = rawEmails.length
    ? await classify(rawEmails)
    : { actionable: [], orders: [], deletable: [] }

  if (actionable.length === 0 && orders.length === 0) {
    await send('✅ Inbox clear')
    auditLog('gmail', 'digest', { actionable: 0, orders: 0, deletable_count: deletable.length })
    return
  }

  const now = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
  const lines = [`📧 <b>Gmail Digest</b> — ${now}`]

  if (actionable.length > 0) {
    lines.push(`\n🔴 <b>Actionable (${actionable.length})</b>`)
    for (const e of actionable) {
      lines.push(`• ${senderName(e.from)} — "${esc(e.subject)}" ${formatAge(e.date)}`)
    }
  }

  if (orders.length > 0) {
    lines.push(`\n📦 <b>Orders (${orders.length})</b>`)
    for (const e of orders) {
      lines.push(`• ${senderName(e.from)} — "${esc(e.subject)}" ${formatAge(e.date)}`)
    }
  }

  lines.push('\n✅ Nothing else needs your attention')

  await send(lines.join('\n'))
  auditLog('gmail', 'digest', { actionable: actionable.length, orders: orders.length, deletable_count: deletable.length })
}

// deletableEmails: pre-classified list to avoid re-fetching between batches.
// On the first call (scheduled/on-demand) this is null and we fetch fresh.
// On subsequent calls (skip/delete-all) we pass the remaining pre-fetched emails.
async function runDeletion(deletableEmails = null) {
  let allDeletable = deletableEmails
  if (!allDeletable) {
    const rawEmails = await listEmails()
    const { deletable } = rawEmails.length
      ? await classify(rawEmails)
      : { deletable: [] }
    allDeletable = deletable
  }

  if (allDeletable.length === 0) return

  const batch = allDeletable.slice(0, 10)
  const rest = allDeletable.slice(10) // remaining emails for subsequent batches
  const batchId = String(Date.now())

  // Store ALL remaining emails so skip/delete-all can continue without re-fetching
  dbRun(
    `INSERT INTO pending_confirmations (action_id, module, description, data, expires_at)
     VALUES (?, 'gmail', ?, ?, ?)
     ON CONFLICT(action_id) DO NOTHING`,
    [batchId, `Deletion batch of ${batch.length} email${batch.length !== 1 ? 's' : ''}`,
     JSON.stringify(allDeletable),
     Math.floor(Date.now() / 1000) + 300]
  )

  const header = rest.length > 0
    ? `🗑 <b>Deletion suggestions</b> — ${batch.length} emails (${rest.length} more after this batch)\n`
    : `🗑 <b>Deletion suggestions</b> — ${batch.length} email${batch.length !== 1 ? 's' : ''}\n`
  const lines = [header]
  batch.forEach((e, i) => {
    lines.push(`${i + 1}. ${senderName(e.from)} — "${esc(e.subject)}" ${formatAge(e.date)}`)
  })

  await sendWithButtons(lines.join('\n'), [[
    { text: '🗑 Delete All',                         callback_data: `gmail_delete_all_${batchId}` },
    { text: '👀 Review',                              callback_data: `gmail_review_${batchId}` },
    { text: rest.length > 0 ? '⏭ Skip Batch' : '⏭ Skip', callback_data: `gmail_skip_${batchId}` },
  ]])

  auditLog('gmail', 'deletion_prompt', { count: batch.length, batchId })
}

export async function run(input = {}) {
  const action = input.action ?? 'digest'
  try {
    if (action === 'deletion') {
      await runDeletion()
    } else {
      await runDigest()
    }
    await heartbeat('gmail')
  } catch (err) {
    await statusError('gmail', err)
    throw err
  }
}

export async function handleCallback(callbackQuery) {
  const { id: callbackQueryId, data } = callbackQuery
  // Acknowledge the button press immediately to dismiss the loading spinner
  await answerCallbackQuery(callbackQueryId, '')

  if (data.startsWith('gmail_skip_')) {
    const batchId = data.slice('gmail_skip_'.length)
    const row = queryOne('SELECT data FROM pending_confirmations WHERE action_id = ?', [batchId])
    const rest = row ? JSON.parse(row.data).slice(10) : []
    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [batchId])
    auditLog('gmail', 'deletion_skipped', { batchId })
    await runDeletion(rest.length > 0 ? rest : null)
    return
  }

  if (data.startsWith('gmail_delete_all_')) {
    const batchId = data.slice('gmail_delete_all_'.length)
    const row = queryOne('SELECT data FROM pending_confirmations WHERE action_id = ?', [batchId])
    if (!row) return
    const allEmails = JSON.parse(row.data)
    const batch = allEmails.slice(0, 10)
    const rest = allEmails.slice(10)
    const ids = batch.map(e => e.id)
    auditLog('gmail', 'delete_batch_start', { count: ids.length, ids })
    const { succeeded, failed } = await trashEmails(ids)
    auditLog('gmail', 'delete_batch_complete', { succeeded, failed, batchId })
    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [batchId])
    await send(failed === 0
      ? `🗑 Trashed ${succeeded} email${succeeded !== 1 ? 's' : ''}`
      : `🗑 Trashed ${succeeded}, ${failed} failed — check logs`)
    await runDeletion(rest.length > 0 ? rest : null)
    return
  }

  if (data.startsWith('gmail_review_')) {
    const batchId = data.slice('gmail_review_'.length)
    const row = queryOne('SELECT data FROM pending_confirmations WHERE action_id = ?', [batchId])
    if (!row) return
    const allEmails = JSON.parse(row.data)
    const batch = allEmails.slice(0, 10)
    const rest = allEmails.slice(10)
    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [batchId])
    for (const e of batch) {
      const lines = [
        `📧 <b>${esc(e.subject)}</b>`,
        `From: ${senderName(e.from)} ${formatAge(e.date)}`,
        `<i>${esc(e.snippet)}</i>`,
      ]
      await sendWithButtons(lines.join('\n'), [[
        { text: '🗑 Trash', callback_data: `gmail_trash_${e.id}` },
        { text: '✅ Keep',  callback_data: `gmail_keep_${e.id}` },
      ]])
    }
    if (rest.length > 0) await runDeletion(rest)
    return
  }

  if (data.startsWith('gmail_trash_')) {
    const msgId = data.slice('gmail_trash_'.length)
    auditLog('gmail', 'trash_single', { msgId })
    await trashEmail(msgId)
    auditLog('gmail', 'trash_single_complete', { msgId })
    return
  }

  if (data.startsWith('gmail_keep_')) {
    const msgId = data.slice('gmail_keep_'.length)
    auditLog('gmail', 'keep_single', { msgId })
    return
  }

  logger.warn('gmail', 'handleCallback-unknown', data)
}
