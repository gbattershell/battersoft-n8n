// scripts/modules/calendar/index.js
import { randomUUID } from 'node:crypto'
import { heartbeat, error as statusError } from '../../core/status.js'
import { logger } from '../../core/logger.js'
import { auditLog, run as dbRun, query, queryOne, getPreference } from '../../core/db.js'
import { send, sendWithButtons, answerCallbackQuery } from '../../core/telegram.js'
import { getEvents, createEvent, updateEvent, deleteEvent, listCalendars } from './caldav-client.js'
import { parse } from './parser.js'
import { registerRoute } from '../../system/http-server.js'

// Register HTTP route for n8n scheduled trigger
registerRoute('POST', '/calendar/digest', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  run({ message: { text: 'cal today' } }).catch(err => logger.error('calendar', 'http-digest-error', err.message))
})

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function token() {
  return randomUUID().slice(0, 8)
}

function getUserTimezone() {
  return getPreference('timezone') || 'America/Chicago'
}

function getCalendars() {
  return query('SELECT * FROM calendar_mapping ORDER BY display_order')
}

function formatTime(isoStr, tz) {
  return new Date(isoStr).toLocaleTimeString('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

function formatDate(isoStr, tz) {
  return new Date(isoStr).toLocaleDateString('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
  })
}

function computeDateRange(keyword, tz) {
  const now = new Date()
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz })

  if (keyword === 'today') {
    return { start: `${todayStr}T00:00:00`, end: `${todayStr}T23:59:59` }
  }
  if (keyword === 'tomorrow') {
    const tom = new Date(now.getTime() + 86_400_000)
    const tomStr = tom.toLocaleDateString('en-CA', { timeZone: tz })
    return { start: `${tomStr}T00:00:00`, end: `${tomStr}T23:59:59` }
  }
  if (keyword === 'this week') {
    const d = new Date(todayStr + 'T12:00:00Z')
    const day = d.getUTCDay()
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((day + 6) % 7))
    const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6)
    const monStr = mon.toISOString().slice(0, 10)
    const sunStr = sun.toISOString().slice(0, 10)
    return { start: `${monStr}T00:00:00`, end: `${sunStr}T23:59:59` }
  }
  if (keyword === 'next week') {
    const d = new Date(todayStr + 'T12:00:00Z')
    const day = d.getUTCDay()
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((day + 6) % 7) + 7)
    const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6)
    const monStr = mon.toISOString().slice(0, 10)
    const sunStr = sun.toISOString().slice(0, 10)
    return { start: `${monStr}T00:00:00`, end: `${sunStr}T23:59:59` }
  }
  return null
}

const READ_KEYWORDS = new Set(['today', 'tomorrow', 'this week', 'next week'])

async function runRead(start, end) {
  const tz = getUserTimezone()
  const calendars = getCalendars()
  if (calendars.length === 0) {
    await listCalendars()
    return runRead(start, end)
  }

  const allEvents = []
  const results = await Promise.all(
    calendars.map(cal => getEvents(cal.caldav_id, start, end))
  )
  for (let i = 0; i < calendars.length; i++) {
    for (const evt of results[i]) {
      allEvents.push({ ...evt, calLabel: calendars[i].display_label, calEmoji: calendars[i].emoji || '' })
    }
  }

  if (allEvents.length === 0) {
    await send('📅 No events scheduled.')
    return
  }

  allEvents.sort((a, b) => {
    if (a.allDay && !b.allDay) return -1
    if (!a.allDay && b.allDay) return 1
    return a.start.localeCompare(b.start)
  })

  const dateLabel = formatDate(start, tz)
  const lines = [`📅 <b>${dateLabel}</b>\n`]
  const buttons = []

  for (const evt of allEvents) {
    const t = token()
    const timeStr = evt.allDay ? '         ' : formatTime(evt.start, tz).padStart(9)
    const label = `${evt.calEmoji ? evt.calEmoji + ' ' : ''}${esc(evt.calLabel)}`
    lines.push(`${timeStr}  ${esc(evt.title)} · ${label}`)

    const payload = JSON.stringify({ calendarUrl: evt.calendarUrl, uid: evt.uid, title: evt.title, start: evt.start, duration: evt.duration, calendar: evt.calLabel })
    const exp = Math.floor(Date.now() / 1000) + 300
    dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      [`cal_edit_${t}`, `Edit ${evt.title}`, payload, exp])
    const t2 = token()
    dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      [`cal_delete_${t2}`, `Delete ${evt.title}`, payload, exp])
    buttons.push([
      { text: '✏️ Edit', callback_data: `cal_edit_${t}` },
      { text: '🗑 Delete', callback_data: `cal_delete_${t2}` },
    ])
  }

  const calendarsWithEvents = new Set(allEvents.map(e => e.calLabel))
  const emptyCount = calendars.length - calendarsWithEvents.size
  if (emptyCount > 0) {
    lines.push(`\nNo events on ${emptyCount} other calendar${emptyCount !== 1 ? 's' : ''}.`)
  }

  await sendWithButtons(lines.join('\n'), buttons)
}

export async function run({ message, editAwait } = {}) {
  try {
    const rawText = message?.text || ''

    if (editAwait) {
      dbRun("DELETE FROM pending_confirmations WHERE action_id = ?", [editAwait.action_id])
      await handleEditDelta(rawText, JSON.parse(editAwait.data))
      await heartbeat('calendar')
      return
    }

    const body = rawText.replace(/^cal\s*/i, '').trim()
    const bodyLower = body.toLowerCase()

    const keyword = READ_KEYWORDS.has(bodyLower) ? bodyLower : null
    if (keyword) {
      const tz = getUserTimezone()
      const range = computeDateRange(keyword, tz)
      await runRead(range.start, range.end)
      await heartbeat('calendar')
      return
    }

    const parsed = await parse(body)
    if (parsed.confidence === 'low' || parsed.intent === 'unknown') {
      await send("I couldn't parse that. Try: <code>cal add dentist Friday 3pm</code>")
      await heartbeat('calendar')
      return
    }

    if (parsed.intent === 'read') {
      await runRead(parsed.start, parsed.end)
    } else if (parsed.intent === 'create') {
      await runCreate(parsed)
    } else if (parsed.intent === 'delete') {
      await runDeleteByText(parsed)
    } else {
      await send("I couldn't parse that. Try: <code>cal add dentist Friday 3pm</code>")
    }

    await heartbeat('calendar')
  } catch (err) {
    await statusError('calendar', err)
    throw err
  }
}

// Stubs for Tasks 9-11
async function runCreate(parsed) {
  throw new Error('Not implemented')
}

async function runDeleteByText(parsed) {
  throw new Error('Not implemented')
}

async function handleEditDelta(text, existingEvent) {
  throw new Error('Not implemented')
}

export async function handleCallback(callbackQuery) {
  throw new Error('Not implemented')
}
