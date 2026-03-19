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

function localISO(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date)
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}

function addMinutesToLocalISO(isoStr, minutes) {
  // Parse isoStr as if it were UTC (safe for arithmetic purposes)
  const ms = new Date(isoStr + 'Z').getTime() + minutes * 60_000
  return new Date(ms).toISOString().slice(0, 19).replace('Z', '')
}

async function findConflicts(startIso, endIso, excludeUid) {
  const tz = getUserTimezone()
  const calendars = getCalendars()
  // Fetch events in a ±2 hour window for proximity check
  const windowStartMs = new Date(startIso + 'Z').getTime() - 2 * 3600_000
  const windowEndMs = new Date(endIso + 'Z').getTime() + 2 * 3600_000
  const wsStr = localISO(new Date(windowStartMs), tz)
  const weStr = localISO(new Date(windowEndMs), tz)

  const results = await Promise.all(calendars.map(cal => getEvents(cal.caldav_id, wsStr, weStr)))
  const allEvents = []
  for (let i = 0; i < calendars.length; i++) {
    for (const evt of results[i]) {
      if (evt.allDay) continue
      if (excludeUid && evt.uid === excludeUid) continue
      allEvents.push({ ...evt, calLabel: calendars[i].display_label })
    }
  }

  const evtStart = new Date(startIso + 'Z').getTime()
  const evtEnd = new Date(endIso + 'Z').getTime()
  const hard = []
  const soft = []

  for (const other of allEvents) {
    const oStart = new Date(other.start + 'Z').getTime()
    const oEnd = new Date(other.end + 'Z').getTime()
    if (evtStart < oEnd && evtEnd > oStart) {
      hard.push(other)
      continue
    }
    const gap = Math.min(Math.abs(evtStart - oEnd), Math.abs(oStart - evtEnd))
    const gapMin = Math.round(gap / 60_000)
    if (gapMin <= 30) {
      soft.push({ ...other, gapMin })
    }
  }

  return { hard, soft }
}

async function runCreate(parsed) {
  const calendars = getCalendars()
  const tz = getUserTimezone()
  const calRow = calendars.find(c => c.display_label === parsed.calendar) || calendars[0]
  const calendarUrl = calRow.caldav_id

  const duration = parsed.duration || 60
  const endIso = addMinutesToLocalISO(parsed.start, duration)
  const { hard, soft } = await findConflicts(parsed.start, endIso, null)

  if (hard.length > 0) {
    const t = token()
    const payload = JSON.stringify({
      actionType: 'create',
      calendarUrl,
      event: { title: parsed.title, start: parsed.start, duration, calendar: parsed.calendar },
    })
    const exp = Math.floor(Date.now() / 1000) + 300
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      [`cal_conflict_confirm_${t}`, `Conflict confirm: ${parsed.title}`, payload, exp]
    )

    const lines = []
    for (const h of hard) {
      lines.push(`⚠️ Conflict: ${esc(parsed.title)} overlaps ${esc(h.title)} (${formatTime(h.start, tz)}–${formatTime(h.end, tz)} · ${esc(h.calLabel)}).`)
    }
    for (const s of soft) {
      lines.push(`💡 Also nearby: ${esc(s.title)} at ${formatTime(s.start, tz)} (${s.gapMin}min gap · ${esc(s.calLabel)}). Heads up.`)
    }
    lines.push('\nSave anyway?')
    await sendWithButtons(lines.join('\n'), [[
      { text: '✅ Yes', callback_data: `cal_conflict_confirm_${t}` },
      { text: '❌ Cancel', callback_data: `cal_cancel_${t}` },
    ]])
    return
  }

  // No hard conflict — create immediately
  const { uid } = await createEvent(calendarUrl, { title: parsed.title, start: parsed.start, duration })

  // Undo row
  const ut = token()
  const undoExp = Math.floor(Date.now() / 1000) + 300
  dbRun(
    "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
    [`cal_undo_${ut}`, `Undo create: ${parsed.title}`, JSON.stringify({ undoType: 'create', calendarUrl, uid }), undoExp]
  )

  auditLog('calendar', 'create_event', { title: parsed.title, calendar: parsed.calendar, start: parsed.start, duration })

  const durationStr = `${duration}m`
  const et = token()
  const editPayload = JSON.stringify({ calendarUrl, uid, title: parsed.title, start: parsed.start, duration, calendar: parsed.calendar })
  const editExp = Math.floor(Date.now() / 1000) + 300
  dbRun(
    "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
    [`cal_edit_${et}`, `Edit ${parsed.title}`, editPayload, editExp]
  )

  await sendWithButtons(
    `✅ ${esc(parsed.title)} — ${formatDate(parsed.start, tz)}, ${formatTime(parsed.start, tz)} (${durationStr}) · ${esc(parsed.calendar)}`,
    [[{ text: '✏️ Edit', callback_data: `cal_edit_${et}` }]]
  )

  // Soft conflict advisory
  if (soft.length > 0) {
    const advisory = soft.map(s =>
      `💡 Also nearby: ${esc(s.title)} at ${formatTime(s.start, tz)} (${s.gapMin}min gap · ${esc(s.calLabel)}). Heads up.`
    ).join('\n')
    await send(advisory)
  }
}

async function runDeleteByText(parsed) {
  throw new Error('Not implemented')
}

async function handleEditDelta(text, existingEvent) {
  throw new Error('Not implemented')
}

export async function handleCallback(callbackQuery) {
  const { id: callbackQueryId, data } = callbackQuery
  await answerCallbackQuery(callbackQueryId, '')

  const tz = getUserTimezone()

  // Cancel handler (for conflict and delete cancel buttons)
  if (data.startsWith('cal_cancel_')) {
    const t = data.slice('cal_cancel_'.length)
    dbRun("DELETE FROM pending_confirmations WHERE action_id LIKE ? AND module = 'calendar'", [`%${t}`])
    await send('Cancelled.')
    return
  }

  // Order matters: check longer prefixes first
  if (data.startsWith('cal_confirm_delete_')) {
    const t = data.slice('cal_confirm_delete_'.length)
    const row = queryOne("SELECT data FROM pending_confirmations WHERE action_id = ?", [`cal_confirm_delete_${t}`])
    if (!row) { await send('This action has expired.'); return }
    const evt = JSON.parse(row.data)
    await deleteEvent(evt.calendarUrl, evt.uid)
    dbRun("DELETE FROM pending_confirmations WHERE action_id = ?", [`cal_confirm_delete_${t}`])
    auditLog('calendar', 'delete_event', { uid: evt.uid, title: evt.title, calendar: evt.calendar })
    await send(`🗑 Deleted: ${esc(evt.title)} — ${formatDate(evt.start, tz)}`)
    return
  }

  if (data.startsWith('cal_conflict_confirm_')) {
    const t = data.slice('cal_conflict_confirm_'.length)
    const row = queryOne("SELECT data FROM pending_confirmations WHERE action_id = ?", [`cal_conflict_confirm_${t}`])
    if (!row) { await send('This action has expired.'); return }
    const payload = JSON.parse(row.data)
    dbRun("DELETE FROM pending_confirmations WHERE action_id = ?", [`cal_conflict_confirm_${t}`])

    if (payload.actionType === 'create') {
      const { uid } = await createEvent(payload.calendarUrl, payload.event)
      const ut = token()
      dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
        [`cal_undo_${ut}`, `Undo: ${payload.event.title}`, JSON.stringify({ undoType: 'create', calendarUrl: payload.calendarUrl, uid }), Math.floor(Date.now() / 1000) + 300])
      auditLog('calendar', 'create_event', payload.event)
      const et = token()
      const editPayload = JSON.stringify({ calendarUrl: payload.calendarUrl, uid, title: payload.event.title, start: payload.event.start, duration: payload.event.duration, calendar: payload.event.calendar })
      dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
        [`cal_edit_${et}`, `Edit ${payload.event.title}`, editPayload, Math.floor(Date.now() / 1000) + 300])
      await sendWithButtons(
        `✅ ${esc(payload.event.title)} — ${formatDate(payload.event.start, tz)}, ${formatTime(payload.event.start, tz)} (${payload.event.duration}m) · ${esc(payload.event.calendar)}`,
        [[{ text: '✏️ Edit', callback_data: `cal_edit_${et}` }]]
      )
    } else if (payload.actionType === 'update') {
      await updateEvent(payload.calendarUrl, payload.uid, payload.changes)
      const ut = token()
      dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
        [`cal_undo_${ut}`, 'Undo update', JSON.stringify({ undoType: 'update', calendarUrl: payload.calendarUrl, uid: payload.uid, original: payload.original }), Math.floor(Date.now() / 1000) + 300])
      auditLog('calendar', 'update_event', { uid: payload.uid, changes: payload.changes })
      await sendWithButtons('✅ Updated.', [[{ text: '↩️ Undo', callback_data: `cal_undo_${ut}` }]])
    }
    return
  }

  if (data.startsWith('cal_edit_')) {
    const t = data.slice('cal_edit_'.length)
    const row = queryOne("SELECT data FROM pending_confirmations WHERE action_id = ?", [`cal_edit_${t}`])
    if (!row) { await send('This action has expired.'); return }
    const evt = JSON.parse(row.data)
    dbRun("DELETE FROM pending_confirmations WHERE action_id = ?", [`cal_edit_${t}`])
    const at = token()
    dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      [`cal_edit_await_${at}`, `Editing: ${evt.title}`, JSON.stringify(evt), Math.floor(Date.now() / 1000) + 300])
    await send('What would you like to change? (time, date, length, or calendar)')
    return
  }

  if (data.startsWith('cal_delete_')) {
    const t = data.slice('cal_delete_'.length)
    const row = queryOne("SELECT data FROM pending_confirmations WHERE action_id = ?", [`cal_delete_${t}`])
    if (!row) { await send('This action has expired.'); return }
    const evt = JSON.parse(row.data)
    dbRun("DELETE FROM pending_confirmations WHERE action_id = ?", [`cal_delete_${t}`])
    const ct = token()
    dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      [`cal_confirm_delete_${ct}`, `Delete: ${evt.title}`, JSON.stringify(evt), Math.floor(Date.now() / 1000) + 300])
    await sendWithButtons(
      `🗑 Delete ${esc(evt.title)} on ${formatDate(evt.start, tz)} at ${formatTime(evt.start, tz)}?`,
      [[
        { text: '🗑 Yes, Delete', callback_data: `cal_confirm_delete_${ct}` },
        { text: '❌ Cancel', callback_data: `cal_cancel_${ct}` },
      ]]
    )
    return
  }

  if (data.startsWith('cal_undo_')) {
    const t = data.slice('cal_undo_'.length)
    const row = queryOne("SELECT data FROM pending_confirmations WHERE action_id = ?", [`cal_undo_${t}`])
    if (!row) { await send('Undo window has passed (5 min). Event not restored.'); return }
    const payload = JSON.parse(row.data)
    dbRun("DELETE FROM pending_confirmations WHERE action_id = ?", [`cal_undo_${t}`])

    if (payload.undoType === 'create') {
      await deleteEvent(payload.calendarUrl, payload.uid)
      auditLog('calendar', 'undo_create', { uid: payload.uid })
      await send('↩️ Event creation undone.')
    } else if (payload.undoType === 'update') {
      await updateEvent(payload.calendarUrl, payload.uid, payload.original)
      auditLog('calendar', 'undo_update', { uid: payload.uid })
      await send('↩️ Edit undone — event restored.')
    } else if (payload.undoType === 'calendar_move') {
      await deleteEvent(payload.newCalendarUrl, payload.newUid)
      await createEvent(payload.originalCalendarUrl, { title: payload.original.title, start: payload.original.start, duration: payload.original.duration })
      auditLog('calendar', 'undo_update', { originalUid: payload.newUid })
      await send('↩️ Calendar move undone — event restored.')
    }
    return
  }

  logger.warn('calendar', 'handleCallback-unknown', data)
}
