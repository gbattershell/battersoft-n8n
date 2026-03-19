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
├── caldav-client.js  — tsdav wrapper (listCalendars, getEvents, createEvent, updateEvent, deleteEvent)
├── parser.js         — Claude haiku NLP: raw text → structured event JSON
├── prompts.js        — all Claude prompt strings (none in index.js)
└── setup.js          — one-time CLI: prompts for Apple ID email + app-specific password, stores via setSecret()
```

**Credentials:** stored encrypted in SQLite:
- `setSecret('caldav_email', email)`
- `setSecret('caldav_password', password)`

No new env vars — `ENCRYPTION_KEY` already exists.

**Wiring:** `telegram-router.js` has a `cal` stub — wire it to call `mod.run({ message })` (no explicit `action`; `run()` determines intent internally). `run()` uses original-case `message.text` for NLP and `message.text.toLowerCase()` for keyword matching.

**CalDAV library:** `tsdav` added to `package.json` and `Dockerfile`.

---

## 4. CalDAV Client

`caldav-client.js` wraps `tsdav` with five operations:

| Function | CalDAV op | Notes |
|---|---|---|
| `listCalendars()` | PROPFIND | Runs once; populates `calendar_mapping` |
| `getEvents(calendarId, start, end)` | REPORT | Fetch events in ISO date range |
| `createEvent(calendarId, event)` | PUT | New VEVENT with generated UUID |
| `updateEvent(calendarId, uid, changes)` | PUT | Fetch current → merge changes → PUT back |
| `deleteEvent(calendarId, uid)` | DELETE | Hard delete on iCloud |

iCloud CalDAV endpoint: `https://caldav.icloud.com`

---

## 5. NLP Parser

`parser.js` calls Claude haiku with the user's raw command text (original case), today's date (ISO), and the list of calendar `display_label` values from `calendar_mapping`.

For `update` intent: the existing event object is also passed by `index.js`.

### Read intent: parser bypassed for keywords

`index.js` extracts the date range directly for common keywords — no Claude call:

| Input | Date range |
|---|---|
| `cal today` | today 00:00–23:59 |
| `cal tomorrow` | tomorrow 00:00–23:59 |
| `cal this week` | Monday–Sunday of current week |
| `cal next week` | Monday–Sunday of next week |
| `cal [other]` | pass to parser for free-form date resolution |

Free-form date expressions (e.g. "cal March 25", "cal next Tuesday") go to the parser which returns `{ intent: 'read', start: '<ISO>', end: '<ISO>', confidence: 'high' }`.

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

### Telegram callback_data limit

Telegram limits `callback_data` to 64 bytes. iCloud UIDs exceed this. All callback buttons use a short numeric token (`String(Date.now())`) as the identifier. Full event state is stored in `pending_confirmations.data` keyed by that token.

### Sub-dispatch in `handleCallback()`

`handleCallback()` must match the **full** `callback_data` prefix string, not tokenize on `_`. Use `data.startsWith('cal_confirm_delete_')` before `data.startsWith('cal_delete_')` etc. to avoid prefix collisions.

### Storage pattern

```js
// Written before sending any message with inline buttons
dbRun(
  "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
  [`cal_${action}_${token}`, description, JSON.stringify(payload), Math.floor(Date.now() / 1000) + 300]
)
```

TTL: 5 minutes for all calendar pending state.

### Per-event rows written during Read

When sending a Read result with [Edit] / [Delete] buttons, `index.js` writes **two rows per event** before sending the message:

| `action_id` | `data` payload |
|---|---|
| `cal_edit_${token}` | `{ calendarId, uid, title, start, duration, calendar }` |
| `cal_delete_${token}` | `{ calendarId, uid, title, start, calendar }` |

These rows let `handleCallback()` retrieve the full event payload when a button is tapped.

### Undo row payload schema

```json
{ "undoType": "create", "calendarId": "...", "uid": "..." }
```
```json
{ "undoType": "update", "calendarId": "...", "uid": "...", "original": { "title": "...", "start": "...", "duration": 60, "calendar": "Garrett" } }
```

- `undoType: 'create'` → `deleteEvent(calendarId, uid)`
- `undoType: 'update'` → `updateEvent(calendarId, uid, original)`

### Conflict-confirm row payload schema

```json
{ "actionType": "create", "calendarId": "...", "event": { "title": "...", "start": "...", "duration": 60, "calendar": "Garrett" } }
```
```json
{ "actionType": "update", "calendarId": "...", "uid": "...", "changes": { "start": "..." }, "original": { "title": "...", "start": "...", "duration": 60, "calendar": "Garrett" } }
```

`actionType` tells `handleCallback()` whether to call `createEvent()` or `updateEvent()`. The `original` field in update rows is stored so Undo works after a conflict-confirmed update.

### Edit mid-flow state

When [Edit] is tapped, `handleCallback()` writes:

- `action_id`: `cal_edit_await_<token>`
- `data`: full existing event JSON `{ calendarId, uid, title, start, duration, calendar, ... }`

On every inbound `cal` message, `run()` checks for a live `cal_edit_await_` row **before** NLP:
```sql
SELECT * FROM pending_confirmations WHERE module = 'calendar' AND action_id LIKE 'cal_edit_await_%' LIMIT 1
```

If found: consume the row (delete it immediately), parse the message as an edit delta in context of the stored event.

If expired (row gone): fall through to normal NLP parsing.

If a new `cal` message arrives while a `cal_conflict_confirm_` is pending (user hasn't responded yet), that conflict confirm row expires naturally. The new message is treated as a fresh command — this is acceptable UX.

---

## 7. `run()` Dispatch Logic

```
1. Check DB for live cal_edit_await_ row
   → If found: delete row, parse message text as edit delta against stored event

2. Check message text (lowercased) for read keywords (today, tomorrow, this week, next week)
   → If matched: run read flow directly, no parser call

3. Otherwise: call parser.js with original-case message text
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

No events on 5 other calendars.
```

Before sending, `index.js`:
1. Generates a token per event
2. Writes `cal_edit_<token>` and `cal_delete_<token>` rows to `pending_confirmations`
3. Attaches [Edit] and [Delete] buttons to each event line using those tokens
4. HTML-escapes all CalDAV-sourced strings (event titles, calendar names) before embedding in messages

### Create

```
cal add dentist Friday 3pm
```

Flow:
1. Parser returns structured event with inferred calendar
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
5. Next `cal` message: `run()` finds `cal_edit_await_` row, deletes it, parses delta
6. Run conflict check on updated event
7. **If hard conflict:** store `cal_conflict_confirm_<token>` with `actionType: 'update'`, `original` fields; send conflict warning
8. **If no hard conflict:** apply update via CalDAV
9. Store `cal_undo_<token>` with `undoType: 'update'` and `original` event
10. Audit log: `update_event`
11. Send confirmation (HTML-escaped):

```
✅ Updated: Dentist — Fri Mar 21, 4:00 PM (30m) · 💁 Kelsey  [Undo]
```

### Delete

Via `cal delete dentist friday` or [Delete] button on a read result.

**Via button:**
1. `handleCallback()` receives `cal_delete_<token>`; **calls `answerCallbackQuery()` first**
2. Retrieve event from `cal_delete_<token>` pending row; delete that row
3. Go to step 4

**Via text command:**
1. Parser returns `{ intent: 'delete', title, calendar, start, ... }`
2. Search all 8 calendars for events matching title + date range (±3 days from parsed start)
3. **If 0 matches:** send "Couldn't find that event. Try `cal today` to see current events."
4. **If multiple matches:** send list with [Delete] button per match (each button writes its own `cal_delete_<token>` row); return — no single confirmation yet
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

---

## 10. Callback Dispatch

Two distinct mechanisms:

### A. `handleCallback()` — Telegram button taps

Match using `data.startsWith(prefix)` with longer prefixes checked first to avoid collisions (e.g., check `cal_confirm_delete_` before `cal_delete_`).

| `callback_data` prefix | First call | Action |
|---|---|---|
| `cal_edit_<token>` | `answerCallbackQuery()` | Retrieve event; write `cal_edit_await_` row; ask what to change |
| `cal_delete_<token>` | `answerCallbackQuery()` | Retrieve event; write `cal_confirm_delete_` row; send "Are you sure?" |
| `cal_confirm_delete_<token>` | `answerCallbackQuery()` | Execute delete; audit log; send confirmation |
| `cal_undo_<token>` | `answerCallbackQuery()` | Revert per `undoType`; audit log |
| `cal_conflict_confirm_<token>` | `answerCallbackQuery()` | Execute create or update per `actionType`; write undo row; audit log |

### B. DB pattern — checked in `run()` on inbound messages

| DB `action_id` pattern | Checked by | Action |
|---|---|---|
| `cal_edit_await_%` | `run()` before NLP | Delete row; parse message as edit delta in context of stored event |

---

## 11. Error Handling

| Scenario | Response |
|---|---|
| CalDAV auth failure | `status.error()` + "Calendar connection failed. Run setup.js to re-authorize." |
| NLP low confidence | Clarification prompt; no action taken |
| No event match (delete by text) | "Couldn't find that event. Try `cal today` to see current events." |
| Multiple event matches (delete by text) | Send list with [Delete] button per match |
| Network timeout | `status.error()` + standard 3-failure Telegram alert via `core/status.js` |
| Undo TTL expired | "Undo window has passed (5 min). Event not restored." |
| Edit-await TTL expired | Row gone; message falls through to normal NLP |
| Callback row not found | Log warning; send "This action has expired." No CalDAV call made. |

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

`telegram.js` uses `parse_mode: 'HTML'`. All CalDAV-sourced strings (event titles, calendar display names, sender-like fields) **must be HTML-escaped** before embedding in any Telegram message. Use the same `esc()` helper pattern established in the Gmail module.

---

## 14. Testing

```
tests/modules/calendar/
├── index.test.js         — mocks caldav-client + parser; tests all UX flows end-to-end
├── parser.test.js        — mocks claude.js; tests JSON output shape for varied inputs
└── caldav-client.test.js — mocks tsdav; tests request construction and response mapping
```

No live CalDAV calls in tests. All external dependencies mocked at module level.

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
2. Call `listCalendars()` with the provided credentials to verify the connection
3. **If connection fails:** log the error; call `process.exit(1)` — credentials are NOT stored
4. **If connection succeeds:** call `setSecret('caldav_email', ...)` and `setSecret('caldav_password', ...)`; populate `calendar_mapping` using `INSERT OR IGNORE`
5. Log: "Calendar authorized. Calendars stored. Run `cal today` to test." Call `process.exit(0)`

---

## 17. Checklist (Pre-PR)

- [ ] `scripts/modules/calendar/` — all 5 files
- [ ] `tsdav` added to `package.json` and `Dockerfile`
- [ ] `telegram-router.js` — `cal` stub wired up
- [ ] `tests/modules/calendar/` — all 3 test files passing
- [ ] `workflows/modules/calendar.json` exported and committed (placeholder)
- [ ] `CHANGELOG.md` entry added
- [ ] No new env vars (none needed)

---

*Built with Claude AI — design approved 2026-03-18*
