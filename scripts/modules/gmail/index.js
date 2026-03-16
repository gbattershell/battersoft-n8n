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
  // Implemented in Task 9
  logger.info('gmail', 'deletion-stub', 'not yet implemented')
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
  // Implemented in Task 9
  logger.info('gmail', 'handleCallback-stub', callbackQuery.data)
}
