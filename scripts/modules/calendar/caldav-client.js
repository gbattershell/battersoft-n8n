// scripts/modules/calendar/caldav-client.js
import { DAVClient } from 'tsdav'
import ICAL from 'ical.js'
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
