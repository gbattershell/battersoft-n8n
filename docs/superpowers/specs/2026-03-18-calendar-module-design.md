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

All 8 are shown on read queries by default. On first `caldav-client.js` call, if `calendar_mapping` is empty, `listCalendars()` runs and populates the table. Event display uses the `display_label` and `emoji` columns — no hardcoded calendar names in business logic.

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

**Credentials:** Apple ID email and app-specific password stored encrypted in SQLite:
- `setSecret('caldav_email', email)`
- `setSecret('caldav_password', password)`

No new env vars required — `ENCRYPTION_KEY` already exists.

**Wiring:** `telegram-router.js` already has the `cal` stub — import and call `mod.run({ action, message })`.

**CalDAV library:** `tsdav` npm package added to `package.json` and `Dockerfile`.

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

`parser.js` calls Claude haiku with:
- User's raw command text
- Today's date (ISO)
- List of calendar `display_label` values from `calendar_mapping`

Returns structured JSON:
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

`intent` values: `create` | `read` | `update` | `delete`

`confidence` values: `high` | `low`

If `confidence` is `low`, `index.js` sends a clarification message instead of acting:
> "I couldn't parse that. Try: `cal add dentist Friday 3pm`"

No event is created or modified on low confidence.

---

## 6. Commands & UX Flows

### Read
```
cal today
cal tomorrow
cal this week
cal [any date or range]
```

Fetches all 8 calendars in parallel, sorts events by time, groups by date:

```
📅 Today — Wed Mar 18

9:00 AM  Dentist · 🧑 Garrett
2:00 PM  School pickup · 👦 Jayden
6:30 PM  Small group · ✝️ Faith

No events on 5 other calendars.
```

Each event in a multi-day view has [Edit] and [Delete] inline buttons.

### Create
```
cal add dentist Friday 3pm
```

Flow:
1. Parser returns structured event with inferred calendar
2. Conflict check runs (see Section 7)
3. If no conflict (or user confirms through conflict): event created
4. Confirmation message sent with [Edit] button:

```
✅ Dentist — Fri Mar 21, 3:00 PM (1h) · 🧑 Garrett  [Edit]
```

### Edit (from [Edit] button on any event)

Flow:
1. Bot sends: "What would you like to change? (time, date, length, or calendar)"
2. User replies in natural language: "move to 4pm" / "make it 30 min" / "put it on Kelsey's calendar"
3. Parser infers the delta in context of the existing event
4. Update applied immediately
5. Confirmation with [Undo] sent:

```
✅ Updated: Dentist — Fri Mar 21, 4:00 PM (30m) · 💁 Kelsey  [Undo]
```

**Edit of pre-existing events** (tapped from a read view) uses the same flow — no confirmation before the update, [Undo] shown after.

**Undo:** the pre-update event state is stored as JSON in `pending_confirmations.data` with a 5-minute TTL. Tapping [Undo] on a create → deletes the event. Tapping [Undo] on an update → PUTs original state back.

### Delete
```
cal delete dentist friday
```
Or via [Delete] button on a viewed event.

Flow:
1. Find matching event
2. Send confirmation:

```
🗑 Delete Dentist on Fri Mar 21 at 4:00 PM?  [Yes, Delete]  [Cancel]
```

3. On [Yes, Delete]: event deleted, confirmation sent: "🗑 Deleted: Dentist — Fri Mar 21"
4. On [Cancel]: "Cancelled." No action taken.

---

## 7. Conflict & Proximity Detection

Runs on every create and edit, across **all 8 calendars**.

**Hard conflict** — overlaps any existing event on any calendar:
```
⚠️ Conflict: Dentist overlaps Team sync (3:00–4:00 PM · Garrett). Save anyway?  [Yes]  [Cancel]
```

**Soft conflict** — another event within 30 minutes on any calendar (advisory only, does not block):
```
💡 Also nearby: School pickup at 4:30 PM (30min gap · Jayden). Heads up.
```

Both warnings shown together in one message if applicable. A single confirm covers both — user taps [Yes] once.

---

## 8. Callback Actions

`handleCallback()` dispatches on `callback_data` prefix:

| Prefix | Action |
|---|---|
| `cal_edit_` | Begin edit flow for event UID |
| `cal_delete_` | Show delete confirmation |
| `cal_confirm_delete_` | Execute delete |
| `cal_undo_` | Revert create or update using stored state |
| `cal_conflict_confirm_` | Proceed with conflicting create/update |

---

## 9. Error Handling

| Scenario | Response |
|---|---|
| CalDAV auth failure | `status.error()` + "Calendar connection failed. Run setup.js to re-authorize." |
| NLP low confidence | Clarification prompt, no action taken |
| Event not found | "Couldn't find that event. Try `cal today` to see current events." |
| Network timeout | `status.error()` + standard 3-failure Telegram alert via `core/status.js` |
| Undo TTL expired | "Undo window has passed (5 min). Event not restored." |

---

## 10. Testing

Test files (Node.js built-in runner, same pattern as Gmail):

```
tests/modules/calendar/
├── index.test.js         — mocks caldav-client + parser; tests all UX flows end-to-end
├── parser.test.js        — mocks claude.js; tests JSON output shape for varied inputs
└── caldav-client.test.js — mocks tsdav; tests request construction and response mapping
```

No live CalDAV calls in tests. All external dependencies mocked at module level.

---

## 11. n8n Workflow

`workflows/modules/calendar.json` — thin wrapper following standard pattern:
- Trigger: HTTP endpoint called by bot service (for any scheduled calendar reminders in future phases)
- For Phase 2, the `cal` command is handled entirely by the bot service via `telegram-router.js`
- Workflow exported and committed but not the primary execution path

---

## 12. Setup

One-time CLI run on host:
```bash
source .env && node scripts/modules/calendar/setup.js
```

Prompts for:
1. Apple ID email
2. App-specific password (generated at appleid.apple.com)

Stores both encrypted in SQLite. Calls `listCalendars()` to verify connection and populate `calendar_mapping`. Exits with `process.exit()` on success.

---

## 13. Checklist (Pre-PR)

- [ ] `scripts/modules/calendar/` — all 5 files
- [ ] `tsdav` added to `package.json` and `Dockerfile`
- [ ] `telegram-router.js` — `cal` stub wired up
- [ ] `tests/modules/calendar/` — all 3 test files passing
- [ ] `workflows/modules/calendar.json` exported and committed
- [ ] `CHANGELOG.md` entry added
- [ ] No new env vars (none needed)

---

*Built with Claude AI — design approved 2026-03-18*
