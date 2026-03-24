// scripts/modules/calendar/setup.js
// One-time CLI to authorize iCloud CalDAV and store credentials.
// Run: source .env && node scripts/modules/calendar/setup.js
import { createInterface } from 'node:readline/promises'
import { setSecret, setPreference, run as dbRun } from '../../core/db.js'

if (!process.env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY is not set. Run: source .env')
  process.exit(1)
}
if (!process.env.DB_PATH) {
  console.error('DB_PATH is not set. Run: source .env')
  process.exit(1)
}

const rl = createInterface({ input: process.stdin, output: process.stdout })

try {
  const email = await rl.question('Apple ID email: ')
  const password = await rl.question('App-specific password: ')
  const tz = (await rl.question('Timezone (default America/Chicago): ')) || 'America/Chicago'

  // Validate timezone
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
  } catch {
    console.error(`Invalid timezone: ${tz}`)
    rl.close()
    process.exit(1)
  }

  // Test connection BEFORE storing credentials (spec requirement: don't store if connection fails)
  console.log('Testing connection...')
  const { DAVClient } = await import('tsdav')
  const testClient = new DAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username: email, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  })
  await testClient.login()
  const rawCalendars = await testClient.fetchCalendars()
  console.log(`\nFound ${rawCalendars.length} calendars:`)
  for (const cal of rawCalendars) {
    console.log(`  - ${cal.displayName}`)
  }

  // Connection succeeded — now store credentials
  setSecret('caldav_email', email)
  setSecret('caldav_password', password)
  setPreference('timezone', tz)

  // Populate calendar_mapping
  for (const cal of rawCalendars) {
    dbRun(
      'INSERT OR IGNORE INTO calendar_mapping (caldav_name, caldav_id, display_label, display_order) VALUES (?, ?, ?, ?)',
      [cal.displayName, cal.url, cal.displayName, 0]
    )
  }

  console.log(`\nTimezone set to: ${tz}`)
  console.log('Calendar authorized. Credentials stored securely in SQLite.')
  console.log('Run `cal today` in Telegram to test.')
  rl.close()
  process.exit(0)
} catch (err) {
  console.error(`Connection failed: ${err.message}`)
  rl.close()
  process.exit(1)
}
