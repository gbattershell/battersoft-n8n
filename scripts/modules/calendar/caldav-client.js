// scripts/modules/calendar/caldav-client.js
import { DAVClient } from 'tsdav'
import { getSecret, getPreference, query, run as dbRun } from '../../core/db.js'
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
