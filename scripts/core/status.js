// scripts/core/status.js
import { getDb, query, queryOne } from './db.js'
import { send } from './telegram.js'

/** Escapes HTML special characters for safe inclusion in Telegram HTML messages. */
function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Records a successful run. Resets consecutive_errors and alert_sent_at. */
export async function heartbeat(moduleName) {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(`
    INSERT INTO module_status (module, last_run, last_success, run_count, error_count, consecutive_errors, alert_sent_at)
    VALUES (?, ?, ?, 1, 0, 0, NULL)
    ON CONFLICT(module) DO UPDATE SET
      last_run = excluded.last_run,
      last_success = excluded.last_success,
      run_count = run_count + 1,
      consecutive_errors = 0,
      alert_sent_at = NULL
  `).run(moduleName, now, now)
}

/** Records a failed run. Sends a Telegram alert after 3 consecutive failures (24h cooldown). */
export async function error(moduleName, err) {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO error_log (ts, module, message, stack) VALUES (?, ?, ?, ?)'
  ).run(now, moduleName, err.message, err.stack ?? null)

  getDb().prepare(`
    INSERT INTO module_status (module, last_run, last_error, run_count, error_count, consecutive_errors)
    VALUES (?, ?, ?, 1, 1, 1)
    ON CONFLICT(module) DO UPDATE SET
      last_run = excluded.last_run,
      last_error = excluded.last_error,
      run_count = run_count + 1,
      error_count = error_count + 1,
      consecutive_errors = consecutive_errors + 1
  `).run(moduleName, now, err.message)

  const row = queryOne(
    'SELECT consecutive_errors, alert_sent_at FROM module_status WHERE module = ?',
    [moduleName]
  )
  if (row.consecutive_errors >= 3) {
    const withinCooldown = row.alert_sent_at && (now - row.alert_sent_at) < 86400
    if (!withinCooldown) {
      await send('\u26a0\ufe0f ' + moduleName + ' has failed 3 times in a row.\nLast error: ' + esc(err.message) + "\nRun 'status' for details.")
      getDb().prepare(
        'UPDATE module_status SET alert_sent_at = ? WHERE module = ?'
      ).run(now, moduleName)
    }
  }
}

/**
 * Returns a formatted status string for all registered modules.
 * Note: error messages from err.message are interpolated as-is. If a module produces
 * error messages containing HTML special characters (&, <, >), those lines may render
 * incorrectly in Telegram's HTML parse mode.
 */
export async function report() {
  const rows = query('SELECT * FROM module_status ORDER BY module')
  const now = Math.floor(Date.now() / 1000)

  const lines = rows.map(row => {
    let icon, detail
    if (row.run_count === 0) {
      icon = '⬜'; detail = 'never run'
    } else if (row.consecutive_errors > 0) {
      icon = '❌'; detail = `FAILED ${age(now - row.last_run)} ago — ${esc(truncate(row.last_error ?? '', 80))}`
    } else if (row.error_count > 0) {
      icon = '⚠️'; detail = 'last run ' + age(now - row.last_run) + ' ago · ' + row.run_count + ' runs · ' + row.error_count + ' errors'
    } else {
      icon = '✅'; detail = 'last run ' + age(now - row.last_run) + ' ago · ' + row.run_count + ' runs · 0 errors'
    }
    return icon + ' ' + row.module.padEnd(12) + ' ' + detail
  })

  const date = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
  const header = '🤖 System Status — ' + date
  return lines.length ? header + '\n\n' + lines.join('\n') : header + '\n\nNo modules registered yet.'
}

function truncate(str, max) {
  if (str.length <= max) return str
  const cut = str.lastIndexOf(' ', max)
  return (cut > 0 ? str.slice(0, cut) : str.slice(0, max)) + '…'
}

function age(seconds) {
  if (seconds < 60)    return seconds + 's'
  if (seconds < 3600)  return Math.floor(seconds / 60) + 'm'
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h'
  return Math.floor(seconds / 86400) + 'd'
}
