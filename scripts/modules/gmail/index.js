// scripts/modules/gmail/index.js
import { heartbeat, error as statusError } from '../../core/status.js'
import { logger } from '../../core/logger.js'
import { auditLog, run as dbRun, queryOne } from '../../core/db.js'
import { send, sendWithButtons } from '../../core/telegram.js'
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

async function runDeletion() {
  const rawEmails = await listEmails()
  const { deletable } = rawEmails.length
    ? await classify(rawEmails)
    : { deletable: [] }

  if (deletable.length === 0) return

  const batch = deletable.slice(0, 50)
  const batchId = String(Date.now())

  dbRun(
    `INSERT INTO pending_confirmations (action_id, module, description, data, expires_at)
     VALUES (?, 'gmail', ?, ?, ?)
     ON CONFLICT(action_id) DO NOTHING`,
    [batchId, `Deletion batch of ${batch.length} email${batch.length !== 1 ? 's' : ''}`,
     JSON.stringify(batch.map(e => e.id)),
     Math.floor(Date.now() / 1000) + 300]
  )

  const lines = [`🗑 <b>Deletion suggestions</b> — ${batch.length} email${batch.length !== 1 ? 's' : ''}\n`]
  batch.slice(0, 10).forEach((e, i) => {
    lines.push(`${i + 1}. ${senderName(e.from)} — "${esc(e.subject)}" ${formatAge(e.date)}`)
  })
  if (batch.length > 10) lines.push(`... and ${batch.length - 10} more`)

  await sendWithButtons(lines.join('\n'), [[
    { text: '🗑 Delete All', callback_data: `gmail_delete_all_${batchId}` },
    { text: '👀 Review',     callback_data: `gmail_review_${batchId}` },
    { text: '⏭ Skip Today', callback_data: `gmail_skip_${batchId}` },
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
  const { data } = callbackQuery

  if (data.startsWith('gmail_skip_')) {
    const batchId = data.slice('gmail_skip_'.length)
    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [batchId])
    auditLog('gmail', 'deletion_skipped', { batchId })
    return
  }

  if (data.startsWith('gmail_delete_all_')) {
    const batchId = data.slice('gmail_delete_all_'.length)
    const row = queryOne('SELECT data FROM pending_confirmations WHERE action_id = ?', [batchId])
    if (!row) return
    const ids = JSON.parse(row.data)
    auditLog('gmail', 'delete_batch_start', { count: ids.length, ids })
    const { succeeded, failed } = await trashEmails(ids)
    auditLog('gmail', 'delete_batch_complete', { succeeded, failed, batchId })
    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [batchId])
    await send(failed === 0
      ? `🗑 Trashed ${succeeded} email${succeeded !== 1 ? 's' : ''}`
      : `🗑 Trashed ${succeeded}, ${failed} failed — check logs`)
    return
  }

  if (data.startsWith('gmail_review_')) {
    const batchId = data.slice('gmail_review_'.length)
    const row = queryOne('SELECT data FROM pending_confirmations WHERE action_id = ?', [batchId])
    if (!row) return
    const ids = JSON.parse(row.data)
    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [batchId])
    for (const id of ids) {
      await sendWithButtons(`📧 Message: <code>${esc(id)}</code>`, [[
        { text: '🗑 Trash', callback_data: `gmail_trash_${id}` },
        { text: '✅ Keep',  callback_data: `gmail_keep_${id}` },
      ]])
    }
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
