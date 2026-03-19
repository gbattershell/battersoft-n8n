# Phase 2 Calendar Module Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full CRUD calendar module for iCloud CalDAV, accessible via `cal` Telegram command, with natural language parsing, conflict detection, and all 8 shared calendars.

**Architecture:** A `caldav-client.js` wraps `tsdav` + `ical.js` to expose clean JSON interfaces. `parser.js` calls Claude haiku for NLP. `index.js` orchestrates all flows (read, create, edit, delete) and callback handling. The router's default fallback is modified to intercept pending edit-await replies.

**Tech Stack:** tsdav (CalDAV client), ical.js (iCalendar parsing/serialization), Node.js built-in test runner, existing core library (telegram.js, db.js, claude.js, status.js, logger.js)

**Spec:** `docs/superpowers/specs/2026-03-18-calendar-module-design.md`

---

## File Map

### New files
| File | Responsibility |
|---|---|
| `scripts/modules/calendar/caldav-client.js` | tsdav + ical.js wrapper; DAVClient singleton; all iCal parsing; timezone conversion |
| `scripts/modules/calendar/parser.js` | Claude haiku NLP — raw text → structured event JSON |
| `scripts/modules/calendar/prompts.js` | All Claude prompt strings |
| `scripts/modules/calendar/index.js` | `run()` + `handleCallback()`; orchestrates read/create/edit/delete flows |
| `scripts/modules/calendar/setup.js` | One-time CLI for Apple ID credentials + timezone |
| `tests/modules/calendar/caldav-client.test.js` | Tests for iCal parsing, timezone, CalDAV wrapper |
| `tests/modules/calendar/parser.test.js` | Tests for NLP output shapes |
| `tests/modules/calendar/index.test.js` | Tests for all UX flows |
| `workflows/modules/calendar.json` | Placeholder n8n workflow |

### Modified files
| File | Change |
|---|---|
| `package.json` | Add `tsdav`, `ical.js` dependencies |
| `scripts/system/telegram-router.js` | Wire `cal` stub + edit-await intercept in default fallback |
| `scripts/system/telegram-router-main.js` | Import calendar module for side-effects |
| `CHANGELOG.md` | Phase 2 entry |

### Schema note
No migration needed. The existing `calendar_mapping` table works as-is:
- `caldav_id` → stores the CalDAV URL (unique identifier for API calls)
- `caldav_name` → stores the CalDAV displayName
- `display_label`, `emoji`, `display_order`, `owner_label` → user-facing display

---

## Chunk 1: Dependencies + CalDAV Client

### Task 1: Create branch and add dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Create branch**

```bash
git checkout -b phase-2-calendar
```

- [ ] **Step 2: Add tsdav and ical.js to package.json**

Add to the `dependencies` object in `package.json`:
```json
"tsdav": "^2.2.0",
"ical.js": "^2.1.0"
```

- [ ] **Step 3: Install dependencies**

```bash
npm install
```

Expected: both packages install without errors. Verify `node_modules/tsdav` and `node_modules/ical.js` exist.

- [ ] **Step 4: Verify Docker build**

```bash
docker build -f Dockerfile.bot -t bot-test .
```

Expected: builds without errors. If native deps fail, troubleshoot before continuing.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add tsdav and ical.js dependencies for calendar module"
```

---

### Task 2: caldav-client.js — DAVClient singleton + listCalendars

**Files:**
- Create: `scripts/modules/calendar/caldav-client.js`
- Create: `tests/modules/calendar/caldav-client.test.js`

- [ ] **Step 1: Write the failing tests for DAVClient singleton and listCalendars**

Create `tests/modules/calendar/caldav-client.test.js`. Mock `tsdav` at module level. Test:
1. `listCalendars()` calls `client.login()` then `client.fetchCalendars()`
2. Returns structured `[{ displayName, url }]` objects
3. Populates `calendar_mapping` table via `INSERT OR IGNORE`
4. Second call to `listCalendars()` reuses the cached client (no second `login()`)
5. Calling any function when secrets are missing throws "Calendar not authorized"

Mock setup pattern (follows Gmail test pattern):
```js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)

// Mock tsdav before importing caldav-client
const mockLogin = mock.fn(async () => {})
const mockFetchCalendars = mock.fn(async () => [
  { displayName: 'Garrett', url: '/cal/garrett/', props: {} },
  { displayName: 'Kelsey', url: '/cal/kelsey/', props: {} },
])
const mockFetchCalendarObjects = mock.fn(async () => [])
const mockCreateCalendarObject = mock.fn(async () => ({}))
const mockUpdateCalendarObject = mock.fn(async () => ({}))
const mockDeleteCalendarObject = mock.fn(async () => ({}))

mock.module('tsdav', {
  namedExports: {
    DAVClient: class MockDAVClient {
      constructor() {}
      login = mockLogin
      fetchCalendars = mockFetchCalendars
      fetchCalendarObjects = mockFetchCalendarObjects
      createCalendarObject = mockCreateCalendarObject
      updateCalendarObject = mockUpdateCalendarObject
      deleteCalendarObject = mockDeleteCalendarObject
    },
  },
})

// Mock ical.js — will be expanded in Task 3
mock.module('ical.js', {
  defaultExport: {
    parse: mock.fn(() => ({})),
    Component: class MockComponent {
      constructor() { this.jCal = ['vcalendar', [], []] }
      getAllSubcomponents() { return [] }
    },
  },
})
```

Import `caldav-client.js` after mocks. Use `setSecret('caldav_email', 'test@icloud.com')` and `setSecret('caldav_password', 'test-pass')` in `beforeEach`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/caldav-client.test.js
```

Expected: FAIL — `caldav-client.js` doesn't exist yet.

- [ ] **Step 3: Implement DAVClient singleton and listCalendars**

Create `scripts/modules/calendar/caldav-client.js`:

```js
import { DAVClient } from 'tsdav'
import { getSecret } from '../../core/db.js'
import { getPreference } from '../../core/db.js'
import { query, run as dbRun } from '../../core/db.js'
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/caldav-client.test.js
```

Expected: all listCalendars tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/modules/calendar/caldav-client.js tests/modules/calendar/caldav-client.test.js
git commit -m "feat(calendar): caldav-client DAVClient singleton + listCalendars with tests"
```

---

### Task 3: caldav-client.js — getEvents with iCal parsing + timezone

**Files:**
- Modify: `scripts/modules/calendar/caldav-client.js`
- Modify: `tests/modules/calendar/caldav-client.test.js`

- [ ] **Step 1: Write failing tests for getEvents**

Add tests to `caldav-client.test.js`:
1. `getEvents(calendarUrl, start, end)` returns `[{ uid, title, start, end, duration, calendarUrl }]`
2. Parses a real VEVENT iCalendar string into the expected JSON shape
3. Converts event times from event timezone to user's local timezone
4. Handles all-day events (`DTSTART;VALUE=DATE`) — returns `{ allDay: true, start: '2026-03-21' }` with no time
5. Returns empty array when no events match

The mock for `fetchCalendarObjects` should return objects with a `.data` property containing a real iCalendar string:

```js
const SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:test-uid-123',
  'DTSTART;TZID=America/Chicago:20260321T150000',
  'DTEND;TZID=America/Chicago:20260321T160000',
  'SUMMARY:Dentist',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')
```

For the ical.js mock, replace it with the **real** `ical.js` module for these tests (remove the mock, or use a more realistic mock that parses the string). Since `caldav-client.test.js` tests iCal parsing directly, it should use the real `ical.js` — only `tsdav` is mocked.

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/caldav-client.test.js
```

Expected: FAIL — `getEvents` not implemented.

- [ ] **Step 3: Implement getEvents with ical.js parsing**

Add to `caldav-client.js`:

```js
import ICAL from 'ical.js'

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
  // Use Intl to find the offset, then adjust
  const date = new Date(localIso + 'Z') // treat as UTC initially
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' })
  const localStr = date.toLocaleString('en-US', { timeZone: tz })
  const diffMs = new Date(utcStr) - new Date(localStr)
  return new Date(date.getTime() + diffMs).toISOString()
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/caldav-client.test.js
```

Expected: all getEvents tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/modules/calendar/caldav-client.js tests/modules/calendar/caldav-client.test.js
git commit -m "feat(calendar): getEvents with ical.js parsing and timezone conversion"
```

---

### Task 4: caldav-client.js — createEvent, updateEvent, deleteEvent

**Files:**
- Modify: `scripts/modules/calendar/caldav-client.js`
- Modify: `tests/modules/calendar/caldav-client.test.js`

- [ ] **Step 1: Write failing tests for create/update/delete**

Add tests:
1. `createEvent(calendarUrl, { title, start, duration })` — calls `client.createCalendarObject` with a valid `.ics` string containing VEVENT, DTSTART with TZID, DTEND, SUMMARY, and a UUID UID. Returns `{ uid }`.
2. `updateEvent(calendarUrl, uid, { start })` — calls `client.fetchCalendarObjects` to get current `.ics`, modifies the DTSTART, calls `client.updateCalendarObject` with updated `.ics`.
3. `updateEvent` with `{ title }` — changes SUMMARY only.
4. `updateEvent` with `{ duration }` — changes DTEND (computed from DTSTART + new duration).
5. `deleteEvent(calendarUrl, uid)` — calls `client.deleteCalendarObject` with the correct URL.

For create tests, inspect the `.ics` string passed to the mock — assert it contains `BEGIN:VEVENT`, `SUMMARY:Dentist`, `DTSTART;TZID=America/Chicago:`, and a valid UID.

For update tests, configure `mockFetchCalendarObjects` to return a known `.ics` string, then assert the updated string passed to `mockUpdateCalendarObject` contains the changed value.

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/caldav-client.test.js
```

Expected: FAIL — functions not implemented.

- [ ] **Step 3: Implement createEvent, updateEvent, deleteEvent**

Add to `caldav-client.js`:

```js
import { randomUUID } from 'node:crypto'

export async function createEvent(calendarUrl, { title, start, duration = 60 }) {
  const client = await getClient()
  const tz = getUserTimezone()
  const uid = randomUUID()

  // Build DTSTART and DTEND from local time + tz
  const dtstart = formatDtstart(start, tz)
  const endDate = new Date(new Date(start).getTime() + duration * 60_000)
  const dtend = formatDtstart(localISO(endDate, tz), tz)

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

  // Fetch current object
  const objects = await client.fetchCalendarObjects({
    calendar: { url: calendarUrl },
  })
  const obj = objects.find(o => o.data && o.data.includes(uid))
  if (!obj) throw new Error(`Event ${uid} not found`)

  // Parse, modify, serialize
  const jcal = ICAL.parse(obj.data)
  const comp = new ICAL.Component(jcal)
  const vevent = comp.getFirstSubcomponent('vevent')
  if (!vevent) throw new Error('No VEVENT in calendar object')

  if (changes.title) {
    vevent.updatePropertyWithValue('summary', changes.title)
  }
  if (changes.start) {
    const dt = ICAL.Time.fromDateTimeString(formatDtstart(changes.start, tz))
    const prop = vevent.getFirstProperty('dtstart')
    prop.setParameter('tzid', tz)
    prop.setValue(dt)
  }
  if (changes.duration) {
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

// Format 'YYYY-MM-DDTHH:mm:ss' to '20260321T150000' (iCal format, no separators)
function formatDtstart(isoLocal) {
  return isoLocal.replace(/[-:]/g, '')
}

// Escape iCalendar text values
function icalEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}
```

Note: The `updateEvent` implementation above is approximate — the exact `ical.js` API for modifying DTSTART with timezone may need adjustment during implementation. The implementer should test against real ical.js behavior and adjust. The key contract is: fetch → parse → modify → serialize → PUT.

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/caldav-client.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/modules/calendar/caldav-client.js tests/modules/calendar/caldav-client.test.js
git commit -m "feat(calendar): createEvent, updateEvent, deleteEvent with iCal serialization"
```

---

## Chunk 2: NLP Parser + Setup + Read Flow

### Task 5: prompts.js

**Files:**
- Create: `scripts/modules/calendar/prompts.js`

- [ ] **Step 1: Create prompts.js with all Claude prompt strings**

```js
// scripts/modules/calendar/prompts.js
// All Claude prompt strings for the calendar module. None in index.js.

export function parseCommandPrompt({ text, today, dayOfWeek, timezone, calendars, existingEvent }) {
  const calendarList = calendars.map(c => c.display_label).join(', ')
  const eventContext = existingEvent
    ? `\nYou are editing an existing event: ${JSON.stringify(existingEvent)}. The user wants to change something about it. Return intent "update" with only the changed fields in "changes".`
    : ''

  return `You are a calendar assistant. Parse the user's command into structured JSON.

Today is ${today} (${dayOfWeek}). User timezone: ${timezone}.
Available calendars: ${calendarList}.
${eventContext}
User command: "${text}"

Return ONLY valid JSON (no markdown, no explanation) matching one of these schemas:

For creating an event:
{"intent":"create","title":"...","calendar":"...","start":"YYYY-MM-DDTHH:mm:ss","duration":60,"confidence":"high"}

For reading events (free-form date):
{"intent":"read","start":"YYYY-MM-DDTHH:mm:ss","end":"YYYY-MM-DDTHH:mm:ss","confidence":"high"}

For deleting an event:
{"intent":"delete","title":"...","calendar":"...","start":"YYYY-MM-DDTHH:mm:ss","duration":60,"confidence":"high"}

For updating an existing event (only changed fields):
{"intent":"update","changes":{"start":"...","duration":30,"calendar":"...","title":"..."},"confidence":"high"}

Rules:
- "calendar" should be the most likely calendar based on context. Default to "${calendars[0]?.display_label || 'Garrett'}" if unclear.
- "duration" defaults to 60 (minutes) if not specified.
- "start" must be an ISO datetime in the user's timezone (${timezone}).
- If the command is ambiguous or you cannot determine the intent, set "confidence" to "low".
- For "update", only include fields that are changing in "changes".`
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/modules/calendar/prompts.js
git commit -m "feat(calendar): prompts.js with NLP parsing prompt"
```

---

### Task 6: parser.js + tests

**Files:**
- Create: `scripts/modules/calendar/parser.js`
- Create: `tests/modules/calendar/parser.test.js`

- [ ] **Step 1: Write failing tests for parser.js**

Create `tests/modules/calendar/parser.test.js`. Mock `claude.js` at module level:

```js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)
process.env.ANTHROPIC_API_KEY = 'test-key'

const mockAsk = mock.fn(async () => '{}')
mock.module('../../../scripts/core/claude.js', {
  namedExports: { ask: mockAsk },
})

const { parse } = await import('../../../scripts/modules/calendar/parser.js')
```

Tests:
1. `parse('add dentist Friday 3pm', { calendars })` — calls `ask()` with haiku model, returns parsed JSON from the mock response
2. When Claude returns `{"intent":"create","title":"Dentist",...,"confidence":"high"}`, `parse()` returns that object
3. When Claude returns invalid JSON, `parse()` returns `{ intent: 'unknown', confidence: 'low' }`
4. When Claude returns `confidence: 'low'`, the result is passed through as-is
5. For update: `parse('move to 4pm', { calendars, existingEvent: {...} })` — passes existing event context to prompt

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/parser.test.js
```

Expected: FAIL — `parser.js` doesn't exist.

- [ ] **Step 3: Implement parser.js**

```js
// scripts/modules/calendar/parser.js
import { ask } from '../../core/claude.js'
import { query } from '../../core/db.js'
import { getPreference } from '../../core/db.js'
import { parseCommandPrompt } from './prompts.js'
import { logger } from '../../core/logger.js'

export async function parse(text, { existingEvent } = {}) {
  const calendars = query('SELECT display_label FROM calendar_mapping ORDER BY display_order')
  const tz = getPreference('timezone') || 'America/Chicago'
  const now = new Date()
  const today = now.toLocaleDateString('en-CA', { timeZone: tz }) // YYYY-MM-DD
  const dayOfWeek = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' })

  const prompt = parseCommandPrompt({ text, today, dayOfWeek, timezone: tz, calendars, existingEvent })
  const raw = await ask(prompt, 'haiku', { module: 'calendar' })

  try {
    // Extract JSON from response (Claude sometimes wraps in markdown)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in response')
    return JSON.parse(jsonMatch[0])
  } catch (err) {
    logger.warn('calendar-parser', 'parse-failed', `Could not parse: ${raw.slice(0, 100)}`)
    return { intent: 'unknown', confidence: 'low' }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/parser.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/modules/calendar/parser.js tests/modules/calendar/parser.test.js
git commit -m "feat(calendar): parser.js Claude haiku NLP with tests"
```

---

### Task 7: setup.js

**Files:**
- Create: `scripts/modules/calendar/setup.js`

- [ ] **Step 1: Implement setup.js**

```js
// scripts/modules/calendar/setup.js
// One-time CLI to authorize iCloud CalDAV and store credentials.
// Run: source .env && node scripts/modules/calendar/setup.js
import { createInterface } from 'node:readline'
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
const ask = (q) => new Promise(resolve => rl.question(q, resolve))

try {
  const email = await ask('Apple ID email: ')
  const password = await ask('App-specific password: ')
  const tz = await ask('Timezone (default America/Chicago): ') || 'America/Chicago'

  // Validate timezone
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
  } catch {
    console.error(`Invalid timezone: ${tz}`)
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

- [ ] **Step 2: Commit**

```bash
git add scripts/modules/calendar/setup.js
git commit -m "feat(calendar): setup.js CLI for iCloud CalDAV authorization"
```

---

### Task 8: index.js — read flow + tests

**Files:**
- Create: `scripts/modules/calendar/index.js`
- Create: `tests/modules/calendar/index.test.js`

- [ ] **Step 1: Write failing tests for run() read flow**

Create `tests/modules/calendar/index.test.js`. Mock `caldav-client.js` and `parser.js` at module level:

```js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_CHAT_ID = '123'
process.env.ANTHROPIC_API_KEY = 'test-key'

const fetchMock = mock.fn(async () => ({ ok: true, json: async () => ({}) }))
global.fetch = fetchMock

const mockGetEvents = mock.fn(async () => [])
const mockListCalendars = mock.fn(async () => [])
const mockCreateEvent = mock.fn(async () => ({ uid: 'new-uid' }))
const mockUpdateEvent = mock.fn(async () => {})
const mockDeleteEvent = mock.fn(async () => {})
mock.module('../../../scripts/modules/calendar/caldav-client.js', {
  namedExports: {
    getEvents: mockGetEvents,
    listCalendars: mockListCalendars,
    createEvent: mockCreateEvent,
    updateEvent: mockUpdateEvent,
    deleteEvent: mockDeleteEvent,
    clearClient: () => {},
  },
})

const mockParse = mock.fn(async () => ({ intent: 'unknown', confidence: 'low' }))
mock.module('../../../scripts/modules/calendar/parser.js', {
  namedExports: { parse: mockParse },
})

const { run, handleCallback } = await import('../../../scripts/modules/calendar/index.js')
const { getDb, run: dbRun, query, setPreference } = await import('../../../scripts/core/db.js')
```

Add `beforeEach` to reset mocks and clear tables. Set up `calendar_mapping` with test data:
```js
beforeEach(() => {
  fetchMock.mock.resetCalls()
  mockGetEvents.mock.resetCalls()
  mockParse.mock.resetCalls()
  mockCreateEvent.mock.resetCalls()
  getDb().prepare('DELETE FROM pending_confirmations').run()
  getDb().prepare('DELETE FROM audit_log').run()
  getDb().prepare('DELETE FROM module_status').run()
  getDb().prepare('DELETE FROM calendar_mapping').run()
  dbRun(
    "INSERT INTO calendar_mapping (caldav_name, caldav_id, display_label, emoji) VALUES (?, ?, ?, ?)",
    ['Garrett', '/cal/garrett/', 'Garrett', '🧑']
  )
  dbRun(
    "INSERT INTO calendar_mapping (caldav_name, caldav_id, display_label, emoji) VALUES (?, ?, ?, ?)",
    ['Kelsey', '/cal/kelsey/', 'Kelsey', '💁']
  )
  setPreference('timezone', 'America/Chicago')
})
```

Tests:
1. `run({ message: { text: 'cal today' } })` — calls `getEvents` for each calendar with today's date range; sends a message with events grouped by time
2. `run({ message: { text: 'cal today' } })` with events — message includes calendar labels and emoji
3. `run({ message: { text: 'cal today' } })` — writes `cal_edit_<token>` and `cal_delete_<token>` rows to `pending_confirmations` per event
4. `run({ message: { text: 'cal today' } })` — HTML-escapes event titles
5. `run({ message: { text: 'cal today' } })` with no events — sends "No events" message
6. `run({ message: { text: 'cal tomorrow' } })` — computes tomorrow's date range
7. `run({ message: { text: 'cal this week' } })` — computes Monday–Sunday range
8. Records heartbeat on success

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/index.test.js
```

Expected: FAIL — `index.js` doesn't exist.

- [ ] **Step 3: Implement index.js with run() read flow**

Create `scripts/modules/calendar/index.js`:

```js
// scripts/modules/calendar/index.js
import { randomUUID } from 'node:crypto'
import { heartbeat, error as statusError } from '../../core/status.js'
import { logger } from '../../core/logger.js'
import { auditLog, run as dbRun, query, queryOne, getPreference } from '../../core/db.js'
import { send, sendWithButtons, answerCallbackQuery } from '../../core/telegram.js'
import { getEvents, createEvent, updateEvent, deleteEvent, listCalendars } from './caldav-client.js'
import { parse } from './parser.js'

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
  // Get today's date string in local tz
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
    await listCalendars()  // auto-populate on first use
    return runRead(start, end)  // retry once
  }

  // Fetch all calendars in parallel
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

  // Sort by start time (all-day events first)
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

    // Store pending rows for edit/delete buttons
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

    // Step 0: edit-await flow (from router intercept)
    if (editAwait) {
      dbRun("DELETE FROM pending_confirmations WHERE action_id = ?", [editAwait.action_id])
      await handleEditDelta(rawText, JSON.parse(editAwait.data))
      await heartbeat('calendar')
      return
    }

    // Step 1: strip 'cal ' prefix
    const body = rawText.replace(/^cal\s*/i, '').trim()
    const bodyLower = body.toLowerCase()

    // Step 2: read keywords
    const keyword = READ_KEYWORDS.has(bodyLower) ? bodyLower : null
    if (keyword) {
      const tz = getUserTimezone()
      const range = computeDateRange(keyword, tz)
      await runRead(range.start, range.end)
      await heartbeat('calendar')
      return
    }

    // Step 3: NLP parse
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
```

The `runCreate`, `runDeleteByText`, `handleEditDelta`, and `handleCallback` functions are stubs at this point — they will be implemented in Tasks 9–11:

```js
async function runCreate(parsed) {
  // Task 9
  throw new Error('Not implemented')
}

async function runDeleteByText(parsed) {
  // Task 10
  throw new Error('Not implemented')
}

async function handleEditDelta(text, existingEvent) {
  // Task 11
  throw new Error('Not implemented')
}

export async function handleCallback(callbackQuery) {
  // Task 10
  throw new Error('Not implemented')
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/index.test.js
```

Expected: read flow tests PASS (stubs for create/delete/edit aren't called in these tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/modules/calendar/index.js tests/modules/calendar/index.test.js
git commit -m "feat(calendar): index.js read flow with keyword matching and multi-calendar display"
```

---

## Chunk 3: Create + Edit + Delete + Callbacks + Wiring

### Task 9: index.js — create flow + conflict detection

**Files:**
- Modify: `scripts/modules/calendar/index.js`
- Modify: `tests/modules/calendar/index.test.js`

- [ ] **Step 1: Write failing tests for create flow**

Add to `index.test.js` in a new `describe('create flow', ...)`:
1. `run({ message: { text: 'cal add dentist Friday 3pm' } })` with parser returning `{ intent: 'create', ... }` — calls `createEvent`, sends confirmation with [Edit] button, writes `cal_undo_<token>` row, logs `create_event` audit
2. Create with hard conflict — `getEvents` returns overlapping event. Sends conflict warning with [Yes] / [Cancel] buttons. Does NOT call `createEvent`. Writes `cal_conflict_confirm_<token>` row with `actionType: 'create'`.
3. Create with soft conflict only (event within 30 min) — calls `createEvent` immediately, sends advisory follow-up message
4. Create with no conflict — no advisory sent

Configure mocks: `mockParse` returns create intent, `mockGetEvents` returns events for conflict checks, `mockCreateEvent` returns `{ uid }`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/index.test.js
```

Expected: FAIL — `runCreate` throws "Not implemented".

- [ ] **Step 3: Implement runCreate + conflict detection**

Replace the `runCreate` stub in `index.js`:

```js
function checkConflicts(start, durationMin, excludeUid = null) {
  // Returns { hard: [...], soft: [...] }
  // hard: overlapping events
  // soft: events within 30 min
}

async function runCreate(parsed) {
  const calendars = getCalendars()
  const tz = getUserTimezone()
  const calRow = calendars.find(c => c.display_label === parsed.calendar) || calendars[0]
  const calendarUrl = calRow.caldav_id

  // Check for conflicts across all calendars
  const endTime = new Date(new Date(parsed.start).getTime() + (parsed.duration || 60) * 60_000)
  const { hard, soft } = await findConflicts(parsed.start, endTime.toISOString(), null)

  if (hard.length > 0) {
    const t = token()
    const payload = { actionType: 'create', calendarUrl, event: { title: parsed.title, start: parsed.start, duration: parsed.duration || 60, calendar: parsed.calendar } }
    dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      [`cal_conflict_confirm_${t}`, `Conflict confirm: ${parsed.title}`, JSON.stringify(payload), Math.floor(Date.now() / 1000) + 300])

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
  const { uid } = await createEvent(calendarUrl, { title: parsed.title, start: parsed.start, duration: parsed.duration || 60 })

  // Undo row
  const ut = token()
  dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
    [`cal_undo_${ut}`, `Undo create: ${parsed.title}`, JSON.stringify({ undoType: 'create', calendarUrl, uid }), Math.floor(Date.now() / 1000) + 300])

  auditLog('calendar', 'create_event', { title: parsed.title, calendar: parsed.calendar, start: parsed.start, duration: parsed.duration || 60 })

  const durationStr = `${parsed.duration || 60}m`
  const et = token()
  const editPayload = JSON.stringify({ calendarUrl, uid, title: parsed.title, start: parsed.start, duration: parsed.duration || 60, calendar: parsed.calendar })
  dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
    [`cal_edit_${et}`, `Edit ${parsed.title}`, editPayload, Math.floor(Date.now() / 1000) + 300])

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

async function findConflicts(startIso, endIso, excludeUid) {
  const tz = getUserTimezone()
  const calendars = getCalendars()
  // Fetch events in a ±2 hour window for proximity check
  const windowStart = new Date(new Date(startIso).getTime() - 2 * 3600_000)
  const windowEnd = new Date(new Date(endIso).getTime() + 2 * 3600_000)
  const wsStr = localISO(windowStart, tz)
  const weStr = localISO(windowEnd, tz)

  const allEvents = []
  const results = await Promise.all(calendars.map(cal => getEvents(cal.caldav_id, wsStr, weStr)))
  for (let i = 0; i < calendars.length; i++) {
    for (const evt of results[i]) {
      if (evt.allDay) continue  // all-day events excluded from conflict
      if (excludeUid && evt.uid === excludeUid) continue
      allEvents.push({ ...evt, calLabel: calendars[i].display_label })
    }
  }

  const evtStart = new Date(startIso).getTime()
  const evtEnd = new Date(endIso).getTime()
  const hard = []
  const soft = []

  for (const other of allEvents) {
    const oStart = new Date(other.start).getTime()
    const oEnd = new Date(other.end).getTime()
    // Hard: overlaps
    if (evtStart < oEnd && evtEnd > oStart) {
      hard.push(other)
      continue
    }
    // Soft: within 30 min
    const gap = Math.min(Math.abs(evtStart - oEnd), Math.abs(oStart - evtEnd))
    const gapMin = Math.round(gap / 60_000)
    if (gapMin <= 30) {
      soft.push({ ...other, gapMin })
    }
  }

  return { hard, soft }
}

// Helper used by multiple functions — format Date to local ISO
function localISO(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date)
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/index.test.js
```

Expected: create flow tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/modules/calendar/index.js tests/modules/calendar/index.test.js
git commit -m "feat(calendar): create flow with conflict/proximity detection"
```

---

### Task 10: index.js — handleCallback (all callbacks)

**Files:**
- Modify: `scripts/modules/calendar/index.js`
- Modify: `tests/modules/calendar/index.test.js`

- [ ] **Step 1: Write failing tests for handleCallback**

Add to `index.test.js` in a new `describe('handleCallback', ...)`:

1. `cal_edit_<token>` — retrieves event from pending row, deletes it, writes `cal_edit_await_<token>` row, sends "What would you like to change?" message
2. `cal_delete_<token>` — retrieves event, writes `cal_confirm_delete_<token>` row, sends "Delete X?" with [Yes, Delete] / [Cancel]
3. `cal_confirm_delete_<token>` — calls `deleteEvent()`, deletes row, logs `delete_event` audit, sends "Deleted" message
4. `cal_undo_<token>` with `undoType: 'create'` — calls `deleteEvent()`, logs `undo_create` audit
5. `cal_undo_<token>` with `undoType: 'update'` — calls `updateEvent()` with original data, logs `undo_update` audit
6. `cal_conflict_confirm_<token>` with `actionType: 'create'` — calls `createEvent()`, writes undo row, sends confirmation
7. `cal_conflict_confirm_<token>` with `actionType: 'update'` — calls `updateEvent()`, writes undo row, sends confirmation
8. Expired/missing row — sends "This action has expired."
9. Cancel button — deletes row, sends "Cancelled."

For each test: insert a `pending_confirmations` row with the appropriate `action_id` and `data`, then call `handleCallback({ id: 'cq1', data: 'cal_<prefix>_<token>' })`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/index.test.js
```

Expected: FAIL — `handleCallback` throws "Not implemented".

- [ ] **Step 3: Implement handleCallback**

Replace the `handleCallback` stub:

```js
export async function handleCallback(callbackQuery) {
  const { id: callbackQueryId, data } = callbackQuery
  await answerCallbackQuery(callbackQueryId, '')

  const tz = getUserTimezone()

  // Cancel handler (for conflict and delete cancel buttons)
  if (data.startsWith('cal_cancel_')) {
    const t = data.slice('cal_cancel_'.length)
    // Find and delete any pending row with this token
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
      // Write a separate edit pending row for the [Edit] button
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
    // Write edit-await row
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
    // Write confirm-delete row
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
      // Delete the event from the new calendar and recreate on the original
      await deleteEvent(payload.newCalendarUrl, payload.newUid)
      await createEvent(payload.originalCalendarUrl, { title: payload.original.title, start: payload.original.start, duration: payload.original.duration })
      auditLog('calendar', 'undo_update', { originalUid: payload.newUid })
      await send('↩️ Calendar move undone — event restored.')
    }
    return
  }

  logger.warn('calendar', 'handleCallback-unknown', data)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/index.test.js
```

Expected: all handleCallback tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/modules/calendar/index.js tests/modules/calendar/index.test.js
git commit -m "feat(calendar): handleCallback — edit, delete, undo, conflict-confirm"
```

---

### Task 11: index.js — edit-await flow + delete by text

**Files:**
- Modify: `scripts/modules/calendar/index.js`
- Modify: `tests/modules/calendar/index.test.js`

- [ ] **Step 1: Write failing tests for edit-await and delete-by-text**

Add to `index.test.js`:

Edit-await tests:
1. `run({ message: { text: 'move to 4pm' }, editAwait: row })` — calls parser with existing event context, calls `updateEvent()`, writes `cal_undo_<token>` row with `undoType: 'update'`, sends updated confirmation with [Undo], logs `update_event` audit
2. Edit-await with hard conflict on updated event — sends conflict warning with `actionType: 'update'`

Delete-by-text tests:
3. `run({ message: { text: 'cal delete dentist friday' } })` with parser returning `{ intent: 'delete' }` and one matching event — writes `cal_confirm_delete_<token>` row, sends "Delete X?" with buttons
4. Delete with 0 matches — sends "Couldn't find that event"
5. Delete with multiple matches — sends list with [Delete] button per match

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/index.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement handleEditDelta and runDeleteByText**

Replace stubs:

```js
async function handleEditDelta(text, existingEvent) {
  const tz = getUserTimezone()
  const parsed = await parse(text, { existingEvent })

  if (parsed.confidence === 'low' || parsed.intent !== 'update') {
    await send("I couldn't understand that change. Try: \"move to 4pm\" or \"change to Tuesday\"")
    return
  }

  // Merge changes onto existing event for conflict check
  const merged = { ...existingEvent, ...parsed.changes }
  const endTime = new Date(new Date(merged.start).getTime() + (merged.duration || existingEvent.duration) * 60_000)
  const { hard, soft } = await findConflicts(merged.start, endTime.toISOString(), existingEvent.uid)

  if (hard.length > 0) {
    const t = token()
    const calRow = getCalendars().find(c => c.display_label === (parsed.changes.calendar || existingEvent.calendar))
    const payload = {
      actionType: 'update',
      calendarUrl: parsed.changes.calendar ? calRow?.caldav_id || existingEvent.calendarUrl : existingEvent.calendarUrl,
      uid: existingEvent.uid,
      changes: parsed.changes,
      original: { title: existingEvent.title, start: existingEvent.start, duration: existingEvent.duration, calendar: existingEvent.calendar },
    }
    dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      [`cal_conflict_confirm_${t}`, `Conflict: update ${existingEvent.title}`, JSON.stringify(payload), Math.floor(Date.now() / 1000) + 300])
    const lines = hard.map(h => `⚠️ Conflict: overlaps ${esc(h.title)} (${formatTime(h.start, tz)}–${formatTime(h.end, tz)} · ${esc(h.calLabel)}).`)
    lines.push('\nSave anyway?')
    await sendWithButtons(lines.join('\n'), [[
      { text: '✅ Yes', callback_data: `cal_conflict_confirm_${t}` },
      { text: '❌ Cancel', callback_data: `cal_cancel_${t}` },
    ]])
    return
  }

  // Apply update
  // If calendar changed, need to delete from old and create on new
  let undoPayload
  if (parsed.changes.calendar && parsed.changes.calendar !== existingEvent.calendar) {
    const newCalRow = getCalendars().find(c => c.display_label === parsed.changes.calendar)
    if (newCalRow) {
      await deleteEvent(existingEvent.calendarUrl, existingEvent.uid)
      const changesForCreate = { ...existingEvent, ...parsed.changes }
      const { uid: newUid } = await createEvent(newCalRow.caldav_id, { title: changesForCreate.title, start: changesForCreate.start, duration: changesForCreate.duration })
      // Undo for calendar move: delete the new event and recreate on the original calendar
      undoPayload = { undoType: 'calendar_move', newCalendarUrl: newCalRow.caldav_id, newUid, originalCalendarUrl: existingEvent.calendarUrl, original: { title: existingEvent.title, start: existingEvent.start, duration: existingEvent.duration, calendar: existingEvent.calendar } }
    }
  } else {
    const calChanges = { ...parsed.changes }
    delete calChanges.calendar // calendar change handled separately above
    if (Object.keys(calChanges).length > 0) {
      await updateEvent(existingEvent.calendarUrl, existingEvent.uid, calChanges)
    }
    undoPayload = { undoType: 'update', calendarUrl: existingEvent.calendarUrl, uid: existingEvent.uid, original: { title: existingEvent.title, start: existingEvent.start, duration: existingEvent.duration, calendar: existingEvent.calendar } }
  }

  // Store undo
  const ut = token()
  dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
    [`cal_undo_${ut}`, `Undo: update ${existingEvent.title}`, JSON.stringify(undoPayload), Math.floor(Date.now() / 1000) + 300])

  auditLog('calendar', 'update_event', { uid: existingEvent.uid, changes: parsed.changes })

  const updated = { ...existingEvent, ...parsed.changes }
  await sendWithButtons(
    `✅ Updated: ${esc(updated.title)} — ${formatDate(updated.start, tz)}, ${formatTime(updated.start, tz)} (${updated.duration || existingEvent.duration}m) · ${esc(updated.calendar || existingEvent.calendar)}`,
    [[{ text: '↩️ Undo', callback_data: `cal_undo_${ut}` }]]
  )

  if (soft.length > 0) {
    const advisory = soft.map(s =>
      `💡 Nearby: ${esc(s.title)} at ${formatTime(s.start, tz)} (${s.gapMin}min gap · ${esc(s.calLabel)}).`
    ).join('\n')
    await send(advisory)
  }
}

async function runDeleteByText(parsed) {
  const tz = getUserTimezone()
  const calendars = getCalendars()

  // Search all calendars ±3 days from parsed start
  const centerDate = new Date(parsed.start)
  const searchStart = new Date(centerDate.getTime() - 3 * 86_400_000)
  const searchEnd = new Date(centerDate.getTime() + 3 * 86_400_000)
  const ssStr = localISO(searchStart, tz)
  const seStr = localISO(searchEnd, tz)

  const matches = []
  const results = await Promise.all(calendars.map(cal => getEvents(cal.caldav_id, ssStr, seStr)))
  for (let i = 0; i < calendars.length; i++) {
    for (const evt of results[i]) {
      if (evt.title.toLowerCase().includes(parsed.title.toLowerCase())) {
        matches.push({ ...evt, calLabel: calendars[i].display_label })
      }
    }
  }

  if (matches.length === 0) {
    await send("Couldn't find that event. Try <code>cal today</code> to see current events.")
    return
  }

  if (matches.length > 1) {
    const lines = ['Multiple matches found:']
    const buttons = []
    for (const m of matches) {
      const t = token()
      const payload = JSON.stringify({ calendarUrl: m.calendarUrl, uid: m.uid, title: m.title, start: m.start, calendar: m.calLabel })
      dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
        [`cal_delete_${t}`, `Delete: ${m.title}`, payload, Math.floor(Date.now() / 1000) + 300])
      lines.push(`• ${esc(m.title)} — ${formatDate(m.start, tz)} at ${formatTime(m.start, tz)} · ${esc(m.calLabel)}`)
      buttons.push([{ text: `🗑 ${m.title}`, callback_data: `cal_delete_${t}` }])
    }
    await sendWithButtons(lines.join('\n'), buttons)
    return
  }

  // Single match — go to confirm flow
  const m = matches[0]
  const ct = token()
  const payload = JSON.stringify({ calendarUrl: m.calendarUrl, uid: m.uid, title: m.title, start: m.start, calendar: m.calLabel })
  dbRun("INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
    [`cal_confirm_delete_${ct}`, `Delete: ${m.title}`, payload, Math.floor(Date.now() / 1000) + 300])
  await sendWithButtons(
    `🗑 Delete ${esc(m.title)} on ${formatDate(m.start, tz)} at ${formatTime(m.start, tz)}?`,
    [[
      { text: '🗑 Yes, Delete', callback_data: `cal_confirm_delete_${ct}` },
      { text: '❌ Cancel', callback_data: `cal_cancel_${ct}` },
    ]]
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-test-module-mocks --test tests/modules/calendar/index.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/modules/calendar/index.js tests/modules/calendar/index.test.js
git commit -m "feat(calendar): edit-await flow + delete-by-text with multi-match handling"
```

---

### Task 12: Wire telegram-router.js + entry point

**Files:**
- Modify: `scripts/system/telegram-router.js`
- Modify: `scripts/system/telegram-router-main.js`

- [ ] **Step 1: Wire the `cal` stub in telegram-router.js**

In `telegram-router.js`, replace:
```js
} else if (text.startsWith('cal')) {
  // Phase 2: calendar
```

With:
```js
} else if (text.startsWith('cal')) {
  const mod = await import('../modules/calendar/index.js')
  await mod.run({ message })
```

- [ ] **Step 2: Add edit-await intercept in the default fallback**

Replace the default fallback:
```js
} else {
  // Default fallback: any unrecognized message triggers gmail digest
  const mod = await import('../modules/gmail/index.js')
  await mod.run({ action: 'digest', message })
}
```

With:
```js
} else {
  // Check for pending calendar edit-await before defaulting to gmail
  const { queryOne: qo } = await import('../core/db.js')
  const editAwait = qo("SELECT * FROM pending_confirmations WHERE module = 'calendar' AND action_id LIKE 'cal_edit_await_%' AND expires_at > unixepoch() LIMIT 1")
  if (editAwait) {
    const mod = await import('../modules/calendar/index.js')
    await mod.run({ message, editAwait })
  } else {
    const mod = await import('../modules/gmail/index.js')
    await mod.run({ action: 'digest', message })
  }
}
```

- [ ] **Step 3: Add calendar import to telegram-router-main.js**

Add after the gmail import:
```js
import '../modules/calendar/index.js'
```

This is only needed if calendar has `registerRoute()` side-effects. Since calendar has no HTTP routes in Phase 2, this import is optional but included for consistency. If it causes import errors during testing (because setup hasn't been run), wrap in a try-catch or defer to when the module has HTTP routes.

Actually — skip this import for now. Calendar has no HTTP routes in Phase 2. The module is loaded lazily via `await import()` in the router. No changes to `telegram-router-main.js` needed.

- [ ] **Step 4: Commit**

```bash
git add scripts/system/telegram-router.js
git commit -m "feat(calendar): wire cal command + edit-await intercept in router"
```

---

### Task 13: CHANGELOG + workflow placeholder + PR prep

**Files:**
- Modify: `CHANGELOG.md`
- Create: `workflows/modules/calendar.json`

- [ ] **Step 1: Add CHANGELOG entry**

Add under `## [Unreleased]` → `### Added` (above the example comments):

```markdown
- Calendar module: full CRUD for iCloud CalDAV via `cal` Telegram command — read (today/tomorrow/this week/next week/free-form), create with conflict detection (hard overlap blocks, soft 30min proximity advisory), edit via [Edit] button + natural language delta + [Undo], delete with confirmation; supports all 8 shared calendars with per-event calendar labels
- `scripts/modules/calendar/caldav-client.js`: tsdav + ical.js wrapper with DAVClient singleton, iCalendar parsing/serialization, timezone conversion
- `scripts/modules/calendar/parser.js`: Claude haiku NLP — natural language → structured event JSON
- `scripts/modules/calendar/setup.js`: one-time CLI for Apple ID email + app-specific password + timezone — stores credentials AES-256-GCM encrypted in SQLite
- Router edit-await intercept: `telegram-router.js` default fallback checks for pending `cal_edit_await_` rows before routing to Gmail, enabling free-text edit replies without `cal` prefix
```

- [ ] **Step 2: Create placeholder n8n workflow**

Create `workflows/modules/calendar.json`:
```json
{
  "name": "Calendar (placeholder)",
  "nodes": [],
  "connections": {},
  "active": false,
  "settings": {},
  "tags": [],
  "notes": "Placeholder for Phase 2 calendar module. The cal command is handled by the bot service. This workflow will be extended when scheduled calendar reminders are added."
}
```

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: all tests pass (gmail + calendar).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md workflows/modules/calendar.json
git commit -m "docs: add Phase 2 calendar CHANGELOG entry and placeholder workflow"
```

- [ ] **Step 5: Use finishing-a-development-branch skill to complete the work**

Push branch and create PR against `main`.

---

## Carry-Forward Issues

### Important

- **Duplicate `localISO` and `addMinutesToLocalISO` helpers** (from Task 9): Both helpers exist in `caldav-client.js` (private, unexported) and were re-implemented in `index.js`. Fix: export from `caldav-client.js`, import in `index.js`, remove local copies. To address in Task 11.
- **`runCreate` crashes on empty `calendar_mapping`** (from Task 9): `calendars[0]` is `undefined` when the table is empty — `calRow.caldav_id` throws. `runRead` guards against this with a `listCalendars()` retry; `runCreate`, `runDeleteByText`, and `handleEditDelta` need the same guard. To address in Task 11.
- **`JSON.parse(row.data)` uncaught in `handleCallback`** (from Task 10): Malformed DB row throws synchronously, potentially crashing the bot callback. Either wrap per-handler in try/catch with logger.error + user message, or confirm `telegram-router-main.js` top-level catch handles it. To address in Task 12 (router review).

### Minor

- **Unused `query` import in `caldav-client.js`** (from Task 2): `query` is imported from `core/db.js` but never used. Remove from the destructuring import when Task 3 next modifies this file. ✅ Fixed in Task 3.
- **Missing cross-timezone conversion test** (from Task 3): Tests only exercise events stored in `America/Chicago` — no test where event's TZID differs from user's display timezone. To add in Task 13 (PR prep) or as a standalone test before merge.
- **Unused `after` import in caldav-client.test.js** (from Task 4): `after` imported from `node:test` but never used. Remove in Task 13.
- **`addMinutesToLocalISO` naive DST arithmetic** (from Task 4): Durations spanning a DST transition produce technically invalid DTEND times (e.g. `02:30` during spring-forward). iCloud handles this gracefully in practice. Acknowledge during PR review.
- **`updateEvent`/`deleteEvent` fetches all calendar objects without time-range** (from Task 4): Fetches entire calendar to find one UID — slow on large calendars. No impact for personal use. Minor optimization for later.
- **`calendar_move` branch in `cal_undo_` is dead code** (from Task 10): No upstream writer creates `undoType: 'calendar_move'` rows. Remove or wire up when calendar-move is implemented.
- **Unknown `actionType` in `cal_conflict_confirm_` has no user feedback** (from Task 10): If `payload.actionType` is neither 'create' nor 'update', the handler silently does nothing. Add `logger.warn` + fallback message.
- **Repeated `pending_confirmations` INSERT string** (from Task 10): Appears 7+ times in `handleCallback`. Consider `insertPending(actionId, description, data, ttlSec)` helper at PR prep if module grows further.
