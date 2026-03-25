// scripts/modules/calendar/index.js
import { heartbeat, error as statusError } from '../../core/status.js'
import { logger } from '../../core/logger.js'
import { query, getPreference } from '../../core/db.js'
import { send } from '../../core/telegram.js'
import { getEvents, listCalendars } from './caldav-client.js'
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

const READ_KEYWORDS = ['today', 'tomorrow', 'this week', 'next week']

// Parse "cal [calendarName?] [timeKeyword]" — returns { keyword, calFilter } or null
function parseReadCommand(body) {
  const lower = body.toLowerCase()
  for (const kw of READ_KEYWORDS) {
    if (lower === kw) return { keyword: kw, calFilter: null }
    if (lower.endsWith(' ' + kw)) {
      const prefix = body.slice(0, lower.lastIndexOf(' ' + kw)).trim()
      return { keyword: kw, calFilter: prefix || null }
    }
  }
  return null
}

function getLocalDay(evt, tz) {
  if (evt.allDay) return evt.start.slice(0, 10)
  return new Date(evt.start).toLocaleDateString('en-CA', { timeZone: tz })
}

function formatDayHeader(dateStr) {
  // dateStr is 'YYYY-MM-DD' — parse as noon UTC to avoid DST edge cases
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  })
}

async function runRead(start, end, calFilter) {
  const tz = getUserTimezone()
  let calendars = getCalendars()
  if (calendars.length === 0) {
    await listCalendars()
    calendars = getCalendars()
  }

  // Apply calendar name filter if provided
  if (calFilter) {
    const filterLower = calFilter.toLowerCase()
    const filtered = calendars.filter(c =>
      c.display_label.toLowerCase().includes(filterLower) ||
      c.caldav_name.toLowerCase().includes(filterLower)
    )
    if (filtered.length > 0) calendars = filtered
  }

  const allEvents = []
  const seen = new Set()
  const results = await Promise.all(
    calendars.map(cal => getEvents(cal.caldav_id, start, end))
  )
  for (let i = 0; i < calendars.length; i++) {
    for (const evt of results[i]) {
      // Dedup by uid+start: same UID across shared calendars = same event;
      // different starts for the same UID = different recurrence instances
      const key = `${evt.uid}:${evt.start}`
      if (seen.has(key)) continue
      seen.add(key)
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

  const isMultiDay = start.slice(0, 10) !== end.slice(0, 10)

  if (!isMultiDay) {
    // Single-day view: simple header + flat list
    const lines = [`📅 <b>${formatDate(start, tz)}</b>\n`]
    for (const evt of allEvents) {
      const timeStr = evt.allDay ? '         ' : formatTime(evt.start, tz).padStart(9)
      const label = `${evt.calEmoji ? evt.calEmoji + ' ' : ''}${esc(evt.calLabel)}`
      lines.push(`${timeStr}  ${esc(evt.title)} · ${label}`)
    }
    await send(lines.join('\n'))
    return
  }

  // Multi-day view: group by day
  const byDay = new Map()
  for (const evt of allEvents) {
    const day = getLocalDay(evt, tz)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(evt)
  }

  const lines = []
  for (const [day, events] of [...byDay.entries()].sort()) {
    lines.push(`📅 <b>${formatDayHeader(day)}</b>`)
    for (const evt of events) {
      const timeStr = evt.allDay ? 'All day' : formatTime(evt.start, tz)
      const label = `${evt.calEmoji ? evt.calEmoji + ' ' : ''}${esc(evt.calLabel)}`
      lines.push(`  ${timeStr}  ${esc(evt.title)} · ${label}`)
    }
    lines.push('')
  }

  await send(lines.join('\n').trimEnd())
}

export async function run({ message } = {}) {
  try {
    const rawText = message?.text || ''
    const body = rawText.replace(/^cal\s*/i, '').trim()

    const parsed = parseReadCommand(body)
    if (parsed) {
      const tz = getUserTimezone()
      const range = computeDateRange(parsed.keyword, tz)
      await runRead(range.start, range.end, parsed.calFilter)
      await heartbeat('calendar')
      return
    }

    await send("Try: <code>cal today</code>, <code>cal this week</code>, or <code>cal kelsey this week</code>")
    await heartbeat('calendar')
  } catch (err) {
    await statusError('calendar', err)
    throw err
  }
}

export async function handleCallback(callbackQuery) {
  // All button-based flows have been removed. Acknowledge any stale callbacks.
  const { answerCallbackQuery } = await import('../../core/telegram.js')
  await answerCallbackQuery(callbackQuery.id, '')
  await send('This action has expired.')
}
