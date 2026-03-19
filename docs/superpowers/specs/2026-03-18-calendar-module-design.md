# Calendar Module — Design Spec
**Date:** 2026-03-18
**Status:** Approved
**Phase:** 2

---

## 1. Overview

A full CRUD calendar module for iCloud CalDAV. Accessible via the `cal` Telegram command prefix. Claude haiku parses natural language commands into structured events. All 8 iCloud calendars are supported — every event display includes its calendar label so the user knows who is doing what. Credentials (Apple ID email + app-specific password) are stored AES-256-GCM encrypted in SQLite via the existing `setSecret`/`getSecret` helpers.

---

## 2. Calendars in Scope

| Calendar | Owner |
|---|---|
| Garrett | Self |
| Kelsey | Wife |
| Jayden | Child |
| Heidi | Dog |
| Family | All |
| Faith | Church/religion |
| Carpenter Family | Wife's family |
| Battershell Family | Self's family |

All 8 are shown on read queries by default. On first `caldav-client.js` call, if `calendar_mapping` is empty, `listCalendars()` runs and populates the table using `INSERT OR IGNORE` (safe against concurrent writes due to the `UNIQUE` constraint on `caldav_id`). Event display uses `display_label` and `emoji` columns — no hardcoded calendar names in business logic.

---

## 3. Architecture & Files

```
scripts/modules/calendar/
├── index.js          — run() + handleCallback(); orchestrates all flows
├── caldav-client.js  — tsdav + ical.js wrapper; all iCalendar parsing/serialization hidden here
├── parser.js         — Claude haiku NLP: raw text → structured event JSON
├── prompts.js        — all Claude prompt strings (none in index.js)
└── setup.js          — one-time CLI: prompts for Apple ID email + app-specific password, stores via setSecret()
```

**Credentials:** stored encrypted in SQLite:
- `setSecret('caldav_email', email)`
- `setSecret('caldav_password', password)`

No new env vars — `ENCRYPTION_KEY` already exists.

**Wiring:** `telegram-router.js` has a `cal` stub — wire it to call `mod.run({ message })`. Additionally, the router's default fallback must check for a pending `cal_edit_await_` row before routing to Gmail (see Section 7).

**Dependencies added to `package.json`:**
- `tsdav` — CalDAV protocol client (service discovery, PROPFIND, REPORT, PUT, DELETE)
- `ical.js` — iCalendar (`.ics`) parsing and serialization (VEVENT ↔ JSON)

Both must be added to `Dockerfile.bot` build and verified to install cleanly in the Docker image.

**Timezone:** A `timezone` user preference is stored in the `preferences` table (default: `America/Chicago`). Set during `setup.js`. All date computations and display formatting use this timezone. `caldav-client.js` converts between local time and UTC for CalDAV REPORT queries and iCalendar `DTSTART`/`DTEND` values.

---

## 4. CalDAV Client

`caldav-client.js` wraps `tsdav` and `ical.js`. It exposes clean JSON interfaces to `index.js` — all iCalendar parsing is internal.

### DAVClient lifecycle

A module-level `DAVClient` singleton is created on first use:

```js
let _client = null

async function getClient() {
  if (_client) return _client
  const email = getSecret('caldav_email')
  const password = getSecret('caldav_password')
  _client = new DAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username: email, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  })
  await _client.login()
  return _client
}
```

On auth errors (401/403), the singleton is cleared (`_client = null`) so the next call retries login. If login itself fails, throw — `index.js` catches and reports "Calendar connection failed."

### Operations

| Function | Returns | Notes |
|---|---|---|
| `listCalendars()` | `[{ displayName, calendarId, url }]` | PROPFIND via `client.fetchCalendars()` |
| `getEvents(calendarUrl, start, end)` | `[{ uid, title, start, end, duration, calendarUrl }]` | REPORT via `client.fetchCalendarObjects({ timeRange })`. Raw `.ics` in each result's `.data` is parsed by `ical.js` into the JSON shape shown. `start`/`end` are ISO strings in the user's local timezone. |
| `createEvent(calendarUrl, event)` | `{ uid }` | Builds a VEVENT `.ics` string from `{ title, start, duration }` using `ical.js`, PUTs via `client.createCalendarObject()`. `DTSTART` includes `TZID` from user preference. Returns the generated UID. |
| `updateEvent(calendarUrl, uid, changes)` | `void` | Fetches the existing calendar object by UID, parses the `.ics` with `ical.js`, applies `changes` (title, start, duration) to the VEVENT component, serializes back to `.ics`, PUTs via `client.updateCalendarObject()`. |
| `deleteEvent(calendarUrl, uid)` | `void` | `client.deleteCalendarObject()` |

**Key distinction:** `calendarUrl` (the full CalDAV URL path for a calendar) is used for all API calls, not `calendarId`. The `calendar_mapping` table stores both `caldav_id` and the full URL in `caldav_name` (or a new `caldav_url` column if needed).

### iCalendar format

All iCalendar parsing and serialization is encapsulated inside `caldav-client.js`. `index.js` never sees raw `.ics` data. The interface is always clean JSON:

```js
// What index.js receives from getEvents():
{ uid: '...', title: 'Dentist', start: '2026-03-21T15:00:00', end: '2026-03-21T16:00:00', duration: 60, calendarUrl: '...' }

// What index.js passes to createEvent():
{ title: 'Dentist', start: '2026-03-21T15:00:00', duration: 60 }

// What index.js passes to updateEvent():
{ start: '2026-03-21T16:00:00', duration: 30 }  // sparse delta
```

### Timezone handling

- **Storage:** iCalendar events use `DTSTART;TZID=<tz>` format (not floating, not UTC) so timezone is preserved.
- **CalDAV queries:** `fetchCalendarObjects({ timeRange })` expects UTC ISO strings. `caldav-client.js` converts the user's local start/end to UTC before querying.
- **Returned events:** `caldav-client.js` converts each event's `DTSTART`/`DTEND` from the event's timezone to the user's local timezone before returning.
- **Display:** `index.js` formats times using `Intl.DateTimeFormat` with the stored timezone preference.
- **All-day events:** `DTSTART;VALUE=DATE` events are displayed without a time, just the date and calendar label.

---

## 5. NLP Parser

`parser.js` calls Claude haiku with:
- The user's command text (**after** stripping the `cal ` prefix — see Section 7)
- Today's date (ISO) and day of week
- The user's timezone
- The list of calendar `display_label` values from `calendar_mapping`
- For `update` intent: the existing event object (passed by `index.js`)

### Read intent: parser bypassed for keywords

`index.js` extracts the date range directly for common keywords — no Claude call:

| Stripped input | Date range (in user's local timezone) |
|---|---|
| `today` | today 00:00–23:59 |
| `tomorrow` | tomorrow 00:00–23:59 |
| `this week` | Monday–Sunday of current week |
| `next week` | Monday–Sunday of next week |
| anything else | pass to parser for free-form date resolution |

Free-form date expressions (e.g. "March 25", "next Tuesday") go to the parser which returns `{ intent: 'read', start: '<ISO>', end: '<ISO>', confidence: 'high' }`.

### Create/Delete output schema
```json
{
  "intent": "create",
  "title": "Dentist",
  "calendar": "Garrett",
  "start": "2026-03-21T15:00:00",
  "duration": 60,
  "confidence": "high"
}
```

### Update output schema (sparse delta — only changed fields)
```json
{
  "intent": "update",
  "changes": {
    "start": "2026-03-21T16:00:00",
    "duration": 30,
    "calendar": "Kelsey"
  },
  "confidence": "high"
}
```

`index.js` merges the delta onto the existing event before calling `updateEvent()`.

**Low confidence:** `index.js` sends a clarification message and takes no action:
> "I couldn't parse that. Try: `cal add dentist Friday 3pm`"

---

## 6. Pending State & Callback IDs

### Token generation

Telegram limits `callback_data` to 64 bytes. iCloud UIDs exceed this. All callback buttons use a **short unique token** as the identifier. Tokens are generated via `crypto.randomUUID().slice(0, 8)` (8 hex chars) — **not** `Date.now()`, which has millisecond resolution and can collide when generating multiple tokens in a tight loop (e.g., two rows per event during Read).

Full event state is stored in `pending_confirmations.data` keyed by that token.

### Sub-dispatch in `handleCallback()`

`handleCallback()` must match the **full** `callback_data` prefix string, not tokenize on `_`. Check longer prefixes first to avoid collisions:
1. `cal_confirm_delete_` (before `cal_delete_`)
2. `cal_conflict_confirm_`
3. `cal_edit_`
4. `cal_delete_`
5. `cal_undo_`

### Storage pattern

```js
const token = crypto.randomUUID().slice(0, 8)
dbRun(
  "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
  [`cal_${action}_${token}`, description, JSON.stringify(payload), Math.floor(Date.now() / 1000) + 300]
)
```

TTL: 5 minutes for all calendar pending state.

### Per-event rows written during Read

When sending a Read result with [Edit] / [Delete] buttons, `index.js` writes **two rows per event** before sending the message. Each event gets its own unique token:

| `action_id` | `data` payload |
|---|---|
| `cal_edit_${token}` | `{ calendarUrl, uid, title, start, duration, calendar }` |
| `cal_delete_${token}` | `{ calendarUrl, uid, title, start, calendar }` |

### Undo row payload schema

```json
{ "undoType": "create", "calendarUrl": "...", "uid": "..." }
```
```json
{ "undoType": "update", "calendarUrl": "...", "uid": "...", "original": { "title": "...", "start": "...", "duration": 60, "calendar": "Garrett" } }
```

- `undoType: 'create'` → `deleteEvent(calendarUrl, uid)`
- `undoType: 'update'` → `updateEvent(calendarUrl, uid, original)`

### Conflict-confirm row payload schema

```json
{ "actionType": "create", "calendarUrl": "...", "event": { "title": "...", "start": "...", "duration": 60, "calendar": "Garrett" } }
```
```json
{ "actionType": "update", "calendarUrl": "...", "uid": "...", "changes": { "start": "..." }, "original": { "title": "...", "start": "...", "duration": 60, "calendar": "Garrett" } }
```

`actionType` tells `handleCallback()` whether to call `createEvent()` or `updateEvent()`. The `original` field in update rows is stored so Undo works after a conflict-confirmed update.

### Edit mid-flow state

When [Edit] is tapped, `handleCallback()` writes:

- `action_id`: `cal_edit_await_<token>`
- `data`: full existing event JSON `{ calendarUrl, uid, title, start, duration, calendar }`

The edit-await row is consumed by the router intercept (Section 7), not by `run()`.

If the row has expired when the user's reply arrives, the message routes normally (to calendar if it starts with `cal`, otherwise to the default fallback).

If a new `cal` message arrives while a `cal_conflict_confirm_` is pending (user hasn't responded yet), that conflict confirm row expires naturally. The new message is treated as a fresh command — this is acceptable UX.

---

## 7. Message Routing & `run()` Dispatch

### Router changes required in `telegram-router.js`

Two changes to the existing router:

**1. Strip `cal ` prefix before calling the module:**

```js
} else if (text.startsWith('cal')) {
  const mod = await import('../modules/calendar/index.js')
  await mod.run({ message })
}
```

**2. Edit-await intercept in the default fallback:**

When the user replies to "What would you like to change?" with free text like "move to 4pm", that message does **not** start with `cal`. Without an intercept, it would route to the Gmail default fallback. The router must check for a pending `cal_edit_await_` row before falling through:

```js
} else {
  // Check if there's a pending calendar edit-await before defaulting to gmail
  const { queryOne: qo } = await import('../core/db.js')
  const editAwait = qo("SELECT * FROM pending_confirmations WHERE module = 'calendar' AND action_id LIKE 'cal_edit_await_%' LIMIT 1")
  if (editAwait) {
    const mod = await import('../modules/calendar/index.js')
    await mod.run({ message, editAwait })
  } else {
    // Default fallback: gmail digest
    const mod = await import('../modules/gmail/index.js')
    await mod.run({ action: 'digest', message })
  }
}
```

When `editAwait` is passed to `run()`, it skips NLP and uses the stored event context directly.

### `run()` dispatch logic

`run()` receives `{ message, editAwait? }`. It strips the `cal ` prefix from `message.text` for all processing:

```
0. If editAwait is provided:
   → Delete the edit-await row; parse message.text (raw, no prefix strip) as edit delta
     against the stored event in editAwait.data

1. Strip 'cal ' prefix (4 chars) from message.text → body
   (e.g. "cal add dentist Friday 3pm" → "add dentist Friday 3pm")

2. Check body (lowercased) for read keywords (today, tomorrow, this week, next week)
   → If matched: compute date range, run read flow, no parser call

3. Otherwise: call parser.js with original-case body
   → Dispatch on returned intent (create / read / update / delete)
```

On success: call `status.heartbeat('calendar')`.
On any unhandled error: call `status.error('calendar', err)` and rethrow.

---

## 8. Commands & UX Flows

### Read

Fetches all 8 calendars in parallel, sorts by time, groups by date:

```
📅 Today — Wed Mar 18

9:00 AM  Dentist · 🧑 Garrett
2:00 PM  School pickup · 👦 Jayden
6:30 PM  Small group · ✝️ Faith
         Spring break (all day) · 👦 Jayden

No events on 5 other calendars.
```

Before sending, `index.js`:
1. Generates a unique token per event (`crypto.randomUUID().slice(0, 8)`)
2. Writes `cal_edit_<token>` and `cal_delete_<token>` rows to `pending_confirmations`
3. Attaches [Edit] and [Delete] buttons to each event line using those tokens
4. HTML-escapes all CalDAV-sourced strings (event titles, calendar names) before embedding in messages

### Create

```
cal add dentist Friday 3pm
```

Flow:
1. Parser receives "add dentist Friday 3pm" (prefix stripped); returns structured event with inferred calendar
2. Run conflict check (Section 9)
3. **If hard conflict:** store `cal_conflict_confirm_<token>` with `actionType: 'create'`; send conflict warning with [Yes] / [Cancel]
4. **If no hard conflict:** create event via CalDAV
5. Store `cal_undo_<token>` with `undoType: 'create'`
6. Audit log: `create_event`
7. Send confirmation (HTML-escaped):

```
✅ Dentist — Fri Mar 21, 3:00 PM (1h) · 🧑 Garrett  [Edit]
```

If soft conflict only (no hard): create event, then send advisory as a follow-up message with no buttons.

### Edit (from [Edit] button)

> **Confirmation policy:** Edit applies immediately with [Undo] shown after. This is intentional and user-approved: the user requested "edit just show the update after doing it with an undo option." The 5-minute Undo window provides recoverability.

Flow:
1. `handleCallback()` receives `cal_edit_<token>`; **calls `answerCallbackQuery()` first**
2. Retrieve event payload from `cal_edit_<token>` pending row; delete that row
3. Write `cal_edit_await_<token>` row with full event JSON
4. Send: "What would you like to change? (time, date, length, or calendar)"
5. User replies with free text (e.g. "move to 4pm") — router intercept catches the `cal_edit_await_` row (Section 7) and routes to `calendar.run({ message, editAwait })`
6. `run()` parses message as edit delta against stored event
7. Run conflict check on updated event
8. **If hard conflict:** store `cal_conflict_confirm_<token>` with `actionType: 'update'`, `original` fields; send conflict warning
9. **If no hard conflict:** apply update via CalDAV
10. Store `cal_undo_<token>` with `undoType: 'update'` and `original` event
11. Audit log: `update_event`
12. Send confirmation (HTML-escaped):

```
✅ Updated: Dentist — Fri Mar 21, 4:00 PM (30m) · 💁 Kelsey  [Undo]
```

### Delete

Via `cal delete dentist friday` or [Delete] button on a read result.

**Via button:**
1. `handleCallback()` receives `cal_delete_<token>`; **calls `answerCallbackQuery()` first**
2. Retrieve event from `cal_delete_<token>` pending row; delete that row
3. Go to shared confirm flow (step 4)

**Via text command:**
1. Parser returns `{ intent: 'delete', title, calendar, start, ... }`
2. Search all 8 calendars for events matching title + date range (±3 days from parsed start)
3. **If 0 matches:** send "Couldn't find that event. Try `cal today` to see current events."
4. **If multiple matches:** send list with [Delete] button per match (each button writes its own `cal_delete_<token>` row); return
5. **If 1 match:** proceed to step 4

**Shared confirm flow (step 4):**
4. Write `cal_confirm_delete_<token>` row with event JSON
5. Send confirmation:

```
🗑 Delete Dentist on Fri Mar 21 at 4:00 PM?  [Yes, Delete]  [Cancel]
```

6. On `cal_confirm_delete_<token>` callback: `answerCallbackQuery()`; retrieve event; call `deleteEvent()`; delete row
7. Audit log: `delete_event`
8. Send: "🗑 Deleted: Dentist — Fri Mar 21"

On [Cancel]: delete `pending_confirmations` row; send "Cancelled."

---

## 9. Conflict & Proximity Detection

Runs on create and edit, across all 8 calendars.

**Hard conflict** — overlaps any existing event on any calendar. Blocks action; user must confirm:
```
⚠️ Conflict: Dentist overlaps Team sync (3:00–4:00 PM · Garrett).
💡 Also nearby: School pickup at 4:30 PM (30min gap · Jayden). Heads up.

Save anyway?  [Yes]  [Cancel]
```

**Soft conflict only** (no hard conflict) — does not block. Event is created/updated immediately. Advisory sent as a separate follow-up message (no buttons):
```
💡 Also nearby: School pickup at 4:30 PM (30min gap · Jayden). Heads up.
```

When both exist, show in one message with [Yes] / [Cancel]. [Yes] means "proceed despite the hard conflict." The [Edit] button on the resulting confirmation is independent and remains active.

All-day events are excluded from conflict detection (they don't occupy a specific time slot).

---

## 10. Callback Dispatch

Two distinct mechanisms:

### A. `handleCallback()` — Telegram button taps

Match using `data.startsWith(prefix)` with longer prefixes checked first:

| `callback_data` prefix | First call | Action |
|---|---|---|
| `cal_confirm_delete_<token>` | `answerCallbackQuery()` | Execute delete; audit log; send confirmation |
| `cal_conflict_confirm_<token>` | `answerCallbackQuery()` | Execute create or update per `actionType`; write undo row; audit log |
| `cal_edit_<token>` | `answerCallbackQuery()` | Retrieve event; write `cal_edit_await_` row; ask what to change |
| `cal_delete_<token>` | `answerCallbackQuery()` | Retrieve event; write `cal_confirm_delete_` row; send "Are you sure?" |
| `cal_undo_<token>` | `answerCallbackQuery()` | Revert per `undoType`; audit log |

### B. Router intercept — checked in `telegram-router.js` default fallback

| DB `action_id` pattern | Checked by | Action |
|---|---|---|
| `cal_edit_await_%` | Router default fallback, before Gmail | Route to `calendar.run({ message, editAwait })` |

---

## 11. Error Handling

| Scenario | Response |
|---|---|
| CalDAV auth failure (401/403) | Clear DAVClient singleton; `status.error()` + "Calendar connection failed. Run setup.js to re-authorize." |
| NLP low confidence | Clarification prompt; no action taken |
| No event match (delete by text) | "Couldn't find that event. Try `cal today` to see current events." |
| Multiple event matches (delete by text) | Send list with [Delete] button per match |
| Network timeout | `status.error()` + standard 3-failure Telegram alert via `core/status.js` |
| Undo TTL expired | "Undo window has passed (5 min). Event not restored." |
| Edit-await TTL expired | Row gone; message routes normally (no special handling) |
| Callback row not found | Log warning; send "This action has expired." No CalDAV call made. |
| iCalendar parse error | Log error; send "Failed to read event data from calendar." |

---

## 12. Audit Logging

All actions call `db.auditLog('calendar', action, detail)` per CLAUDE.md:

| Event | `action` | `detail` |
|---|---|---|
| Create | `create_event` | `{ title, calendar, start, duration }` |
| Update | `update_event` | `{ uid, changes }` |
| Delete | `delete_event` | `{ uid, title, calendar }` |
| Undo create | `undo_create` | `{ uid }` |
| Undo update | `undo_update` | `{ uid }` |

---

## 13. HTML Escaping

`telegram.js` uses `parse_mode: 'HTML'`. All CalDAV-sourced strings (event titles, calendar display names) **must be HTML-escaped** before embedding in any Telegram message. Use the same `esc()` helper pattern established in the Gmail module.

---

## 14. Testing

```
tests/modules/calendar/
├── index.test.js         — mocks caldav-client + parser; tests all UX flows end-to-end
├── parser.test.js        — mocks claude.js; tests JSON output shape for varied inputs
└── caldav-client.test.js — mocks tsdav; tests iCal parsing, timezone conversion, request/response mapping
```

No live CalDAV calls in tests. All external dependencies mocked at module level. `caldav-client.test.js` should include tests for:
- Parsing real iCalendar VEVENT strings into the JSON shape
- Timezone conversion (event in `America/New_York` displayed in `America/Chicago`)
- All-day event handling (`DTSTART;VALUE=DATE`)
- Building a valid `.ics` string from JSON input

---

## 15. n8n Workflow

`workflows/modules/calendar.json` — placeholder scaffold only. The `cal` command is handled entirely by the bot service. This workflow will be extended when scheduled calendar features are added in a future phase.

---

## 16. Setup

```bash
source .env && node scripts/modules/calendar/setup.js
```

Pre-conditions checked on startup: `ENCRYPTION_KEY` and `DB_PATH` must be set; exit with error if missing.

Order of operations:
1. Prompt for Apple ID email and app-specific password
2. Prompt for timezone (default: `America/Chicago`) — validated against `Intl.supportedValuesOf('timeZone')`
3. Call `listCalendars()` with the provided credentials to verify the connection (creates a `DAVClient`, calls `login()`, then `fetchCalendars()`)
4. **If connection fails:** log the error; call `process.exit(1)` — credentials are NOT stored
5. **If connection succeeds:**
   - `setSecret('caldav_email', ...)` and `setSecret('caldav_password', ...)`
   - `setPreference('timezone', tz)`
   - Populate `calendar_mapping` using `INSERT OR IGNORE`
   - Display discovered calendars with their display names
6. Log: "Calendar authorized. Calendars stored. Run `cal today` to test." Call `process.exit(0)`

---

## 17. Checklist (Pre-PR)

- [ ] `scripts/modules/calendar/` — all 5 files
- [ ] `tsdav` and `ical.js` added to `package.json`
- [ ] `Dockerfile.bot` verified to build cleanly with new deps
- [ ] `telegram-router.js` — `cal` stub wired up + edit-await intercept in default fallback
- [ ] `tests/modules/calendar/` — all 3 test files passing
- [ ] `workflows/modules/calendar.json` exported and committed (placeholder)
- [ ] `CHANGELOG.md` entry added
- [ ] No new env vars (none needed)

---

*Built with Claude AI — design approved 2026-03-18*
