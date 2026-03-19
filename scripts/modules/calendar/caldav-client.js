// scripts/modules/calendar/caldav-client.js
import { DAVClient } from 'tsdav'
import ICAL from 'ical.js'
import { randomUUID } from 'node:crypto'
import { getSecret, getPreference, run as dbRun } from '../../core/db.js'
import { logger } from '../../core/logger.js'

let _client = null

export async function getClient() {
  if (_client) return _client
  const email = getSecret('caldav_email')
  const password = getSecret('caldav_password')
  if (!email || !password) {
    throw new Error('Calendar not authorized — run: source .env && node scripts/modules/calendar/setup.js')
  }
  _client = new DAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username: email, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  })
  await _client.login()
  return _client
}

export function clearClient() {
  _client = null
}

function getUserTimezone() {
  return getPreference('timezone') || 'America/Chicago'
}

export async function listCalendars() {
  const client = await getClient()
  const calendars = await client.fetchCalendars()
  for (const cal of calendars) {
    dbRun(
      `INSERT OR IGNORE INTO calendar_mapping (caldav_name, caldav_id, display_label)
       VALUES (?, ?, ?)`,
      [cal.displayName || '', cal.url, cal.displayName || '']
    )
  }
  return calendars.map(c => ({ displayName: c.displayName, url: c.url }))
}

// Helper: convert iCal VEVENT to plain JSON in user's timezone
function parseVEvent(vevent, calendarUrl, tz) {
  const summary = vevent.getFirstPropertyValue('summary') || '(no title)'
  const dtstart = vevent.getFirstPropertyValue('dtstart')
  const dtend = vevent.getFirstPropertyValue('dtend')
  const uid = vevent.getFirstPropertyValue('uid') || ''

  // All-day event: DTSTART is a DATE (no time component)
  if (dtstart.isDate) {
    return {
      uid,
      title: summary,
      start: dtstart.toString(),  // 'YYYY-MM-DD'
      end: dtend ? dtend.toString() : dtstart.toString(),
      duration: null,
      allDay: true,
      calendarUrl,
    }
  }

  // Timed event: convert to user's timezone for display
  const startJs = dtstart.toJSDate()
  const endJs = dtend ? dtend.toJSDate() : new Date(startJs.getTime() + 3600_000)
  const durationMin = Math.round((endJs - startJs) / 60_000)

  return {
    uid,
    title: summary,
    start: localISO(startJs, tz),
    end: localISO(endJs, tz),
    duration: durationMin,
    allDay: false,
    calendarUrl,
  }
}

// Format a Date to 'YYYY-MM-DDTHH:mm:ss' in a given timezone
function localISO(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}

export async function getEvents(calendarUrl, start, end) {
  const client = await getClient()
  const tz = getUserTimezone()

  // Convert local start/end to UTC for the CalDAV time-range query
  const startUtc = new Date(localToUtc(start, tz)).toISOString()
  const endUtc = new Date(localToUtc(end, tz)).toISOString()

  const objects = await client.fetchCalendarObjects({
    calendar: { url: calendarUrl },
    timeRange: { start: startUtc, end: endUtc },
  })

  const events = []
  for (const obj of objects) {
    if (!obj.data) continue
    try {
      const jcal = ICAL.parse(obj.data)
      const comp = new ICAL.Component(jcal)
      for (const vevent of comp.getAllSubcomponents('vevent')) {
        events.push(parseVEvent(vevent, calendarUrl, tz))
      }
    } catch (err) {
      logger.warn('caldav-client', 'ical-parse-error', err.message)
    }
  }
  return events
}

// Convert 'YYYY-MM-DDTHH:mm:ss' in local tz to a UTC timestamp
function localToUtc(localIso, tz) {
  const date = new Date(localIso + 'Z') // treat as UTC initially
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' })
  const localStr = date.toLocaleString('en-US', { timeZone: tz })
  const diffMs = new Date(utcStr) - new Date(localStr)
  return new Date(date.getTime() + diffMs).toISOString()
}

// Format 'YYYY-MM-DDTHH:mm:ss' to '20260321T150000' (iCal compact format, no separators)
function formatDtstart(isoLocal) {
  return isoLocal.replace(/[-:]/g, '')
}

// Escape iCalendar text values
function icalEscape(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

// Add minutes to a local ISO string ('YYYY-MM-DDTHH:mm:ss') without timezone confusion
function addMinutesToLocalISO(localIso, minutes) {
  const [datePart, timePart] = localIso.split('T')
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute, second] = timePart.split(':').map(Number)
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  d.setUTCMinutes(d.getUTCMinutes() + minutes)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

export async function createEvent(calendarUrl, { title, start, duration = 60 }) {
  const client = await getClient()
  const tz = getUserTimezone()
  const uid = randomUUID()

  const dtstart = formatDtstart(start)
  const dtend = formatDtstart(addMinutesToLocalISO(start, duration))

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//battersoft//calendar//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART;TZID=${tz}:${dtstart}`,
    `DTEND;TZID=${tz}:${dtend}`,
    `SUMMARY:${icalEscape(title)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  await client.createCalendarObject({
    calendar: { url: calendarUrl },
    filename: `${uid}.ics`,
    iCalString: ics,
  })
  return { uid }
}

export async function updateEvent(calendarUrl, uid, changes) {
  const client = await getClient()
  const tz = getUserTimezone()

  const objects = await client.fetchCalendarObjects({
    calendar: { url: calendarUrl },
  })
  const obj = objects.find(o => o.data && o.data.includes(uid))
  if (!obj) throw new Error(`Event ${uid} not found`)

  const jcal = ICAL.parse(obj.data)
  const comp = new ICAL.Component(jcal)
  const vevent = comp.getFirstSubcomponent('vevent')
  if (!vevent) throw new Error('No VEVENT in calendar object')

  if (changes.title !== undefined) {
    vevent.updatePropertyWithValue('summary', changes.title)
  }
  if (changes.start !== undefined) {
    const prop = vevent.getFirstProperty('dtstart')
    prop.setParameter('tzid', tz)
    // fromDateTimeString requires ISO format with dashes and colons
    prop.setValue(ICAL.Time.fromDateTimeString(changes.start))
  }
  if (changes.duration !== undefined) {
    const dtstart = vevent.getFirstPropertyValue('dtstart')
    const startJs = dtstart.toJSDate()
    const endJs = new Date(startJs.getTime() + changes.duration * 60_000)
    const dtend = ICAL.Time.fromJSDate(endJs)
    vevent.updatePropertyWithValue('dtend', dtend)
  }

  await client.updateCalendarObject({
    calendarObject: { url: obj.url, data: comp.toString(), etag: obj.etag },
  })
}

export async function deleteEvent(calendarUrl, uid) {
  const client = await getClient()

  const objects = await client.fetchCalendarObjects({
    calendar: { url: calendarUrl },
  })
  const obj = objects.find(o => o.data && o.data.includes(uid))
  if (!obj) throw new Error(`Event ${uid} not found for deletion`)

  await client.deleteCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag } })
}
