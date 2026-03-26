# Tiller Budget Module — Design Spec
**Date:** 2026-03-25
**Phase:** 3
**Status:** Draft
**Depends on:** Phase 0 (infrastructure), Phase 1 (Gmail — shares Google Cloud project credentials)

---

## 1. Overview

A read-only Google Sheets integration for the Tiller Foundation spreadsheet. Users ask budget questions via Telegram (`$` prefix), and Claude analyzes the raw transaction data to answer. A weekly digest runs on a schedule.

**Two modes of interaction:**
1. **On-demand Q&A** — `$ how much did I spend on groceries this month?`
2. **Weekly digest** — Scheduled Sunday 12:00 PM, sent automatically to Telegram

All queries are read-only. The module never writes to the Tiller spreadsheet.

---

## 2. Architecture

**Dependency:** `googleapis` npm package (already installed from Gmail module).

```
User: "$ how much on groceries this month?"
  │
  ▼
telegram-router.js (text.startsWith('$'))
  │
  ▼
scripts/modules/tiller/index.js → run({ message })
  │
  ├─► sheets-client.js → fetchSheetData(sheetId)
  │     Creates OAuth2 client from stored sheets_refresh_token
  │     googleapis batchGet: Transactions + Categories sheets
  │     Returns: { transactions: [...], categories: [...] }
  │
  ├─► prompts.js → buildQueryPrompt({ question, transactions, categories, today })
  │     Pre-aggregates in JS, passes summarized data to Claude
  │
  ├─► claude.ask(prompt, 'haiku', { module: 'tiller' })
  │
  └─► telegram.send(response)
      status.heartbeat('tiller')
```

**Weekly digest:**
```
n8n Schedule Trigger (Sunday 12:00 PM)
  │
  ▼
POST http://bot:3000/tiller/weekly-digest
  │
  ▼
tiller/index.js → weeklyDigest()
  Same data pipeline, fixed prompt
  Sends via telegram.sendDigest(sections)
```

---

## 3. Data Model

### Google Sheets Structure (Standard Tiller Foundation)

**Transactions sheet columns:**
`Date | Description | Category | Amount | Account | Account # | Institution | Month | Week | Transaction ID | Account ID | Check Number | Full Description | Date Added | Category Hint | Categorized By | Categorized Date | Source`

**Categories sheet columns:**
`Category | Group | Type | Amount (monthly budget target)`

### Internal Data Representation

```js
// Transaction (after parsing from sheet row)
{
  date: Date,
  description: string,
  category: string,
  amount: number,        // negative = expense, positive = income
  account: string,
  institution: string,
  fullDescription: string
}

// Category (after parsing from sheet row)
{
  name: string,
  group: string,         // e.g. "Food", "Housing", "Transportation"
  type: string,          // "Expense" or "Income"
  budget: number         // monthly budget target, 0 if unbudgeted
}
```

### Data Fetching Strategy

- **No caching** — fetch fresh from Sheets API on every request
- **Single batchGet call** per request — reads Transactions and Categories in one API round-trip
- **Header row detection** — parse column names from row 1, map dynamically (resilient to column reordering)
- **Smart windowing** — simple keyword matching for date ranges ("this month", "last week", "March", "this year"). Falls back to current month if no date range detected. No extra Claude call for date parsing — just regex/keyword heuristics in JS.

---

## 4. Authentication

Separate OAuth consent flow for Google Sheets, following the same pattern as Gmail.

**Scope:** `https://www.googleapis.com/auth/spreadsheets.readonly`

**Implementation:**
- New `scripts/modules/tiller/setup.js` — one-time OAuth consent script (mirrors `gmail/setup.js`)
- Requests only `spreadsheets.readonly` scope
- Stores the refresh token in SQLite under key `sheets_refresh_token` (separate from `gmail_refresh_token`)
- Uses the same `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars (same Google Cloud project)
- Run once on setup: `source .env && node scripts/modules/tiller/setup.js`

**`sheets-client.js` auth pattern** (mirrors `gmail/gmail-client.js`):
- Creates a fresh `google.auth.OAuth2` client using `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- Loads `sheets_refresh_token` from `db.getSecret()`
- Listens for `tokens` event to rotate the refresh token via `db.setSecret()`

**Prerequisites:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `ENCRYPTION_KEY` must already be configured (from Phase 1 Gmail setup).

**Read-only enforcement:** The `sheets-client.js` module only exposes `batchGet` operations. No spreadsheet write methods are implemented or imported.

---

## 5. File Structure

```
scripts/modules/tiller/
├── index.js          # run() for $ commands, weeklyDigest() for scheduled digest
├── prompts.js        # buildQueryPrompt, buildWeeklyDigestPrompt, buildBudgetCheckPrompt
├── sheets-client.js  # Google Sheets API wrapper (fetchSheetData, OAuth2 client)
└── setup.js          # One-time OAuth consent for spreadsheets.readonly scope
```

---

## 6. Module Entry Points

### `run({ message })` — On-demand queries

Called by the router when a message starts with `$`.

1. Strip the `$` prefix to extract the question
2. Call `fetchSheetData()` to get transactions and categories
3. Determine date window from the question (default: current month)
4. Pre-aggregate data in JS (sum by category, filter by date range)
5. Build prompt with `buildQueryPrompt()`
6. Call `claude.ask()` with haiku
7. Send response via `telegram.send()`
8. Log via `db.auditLog('tiller', 'query', { question })`
9. Call `status.heartbeat('tiller')`

### `weeklyDigest()` — Scheduled weekly summary

Called via HTTP endpoint `POST /tiller/weekly-digest`.

1. Fetch all transactions for the current month
2. Compute: spending by category, budget remaining, uncategorized count
3. Build prompt with `buildWeeklyDigestPrompt()`
4. Call `claude.ask()` with haiku
5. Send via `telegram.sendDigest()`
6. Log via `db.auditLog('tiller', 'weekly_digest', { transactionCount, weekTotal })`
7. Call `status.heartbeat('tiller')`

### `handleCallback(callbackQuery)` — Button callbacks

Export a stub that answers the callback query with "This action has expired" (matching the calendar module pattern). Can be expanded later if the digest adds interactive elements.

---

## 7. Prompt Strategy

### `buildQueryPrompt({ question, data, categories, today })`

- Receives pre-aggregated data (not raw rows) when possible
- For specific queries ("groceries this month"), passes category-filtered summary
- For broad queries ("biggest expenses"), passes top-N transactions
- Instructs Claude: answer concisely, use HTML formatting for Telegram, bold totals, currency formatting
- Includes today's date for relative date interpretation

### `buildWeeklyDigestPrompt({ weekTransactions, monthByCategory, budgets, uncategorizedCount })`

Fixed output format:
```
💰 Weekly Spending Digest — {date}

Total spent this week: ${amount}

📊 Budget Status ({month})
Category          Spent    Budget   Remaining
{category}        ${spent} ${budget} ${remaining} {emoji}
...

⚠️ = <10% remaining · 🚨 = over budget

📋 Uncategorized: {count} transactions need review
```

Emoji rules:
- ⚠️ next to categories with <10% budget remaining
- 🚨 next to categories that are over budget
- No emoji for healthy categories

### `buildBudgetCheckPrompt({ monthByCategory, budgets })`

Used when the question is specifically about budget status. Returns over/under for each budgeted category and overall monthly pace.

---

## 8. Router & Scheduling Integration

### Router (telegram-router.js)

Add `$` prefix case to `handleUpdate()`:
```js
if (text.startsWith('$')) {
  const tiller = await import('../modules/tiller/index.js')
  return tiller.run({ message })
}
```

The router already has a commented placeholder for this prefix.

### HTTP Endpoint (telegram-router-main.js)

Add import alongside existing Gmail import in `telegram-router-main.js`:
```js
import '../modules/gmail/index.js'   // existing
import '../modules/tiller/index.js'  // new — triggers registerRoute() side-effect
```

Inside `tiller/index.js`, register the route following the Gmail pattern (send 200 immediately, run async):
```js
registerRoute('POST', '/tiller/weekly-digest', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  weeklyDigest().catch(err => statusError('tiller', err))
})
```

### n8n Workflow (workflows/modules/tiller-weekly-digest.json)

- **Trigger:** Schedule Trigger — Sunday 12:00 PM
- **Action:** HTTP Request → POST `http://bot:3000/tiller/weekly-digest`
- **Error branch:** wired to Telegram error alert (standard pattern)
- **Note:** This is separate from the main "weekly summary" workflow (Sunday 7:00 PM in the design spec). The Tiller digest runs at noon; the general weekly summary runs in the evening.

---

## 9. Environment Variables

Added to `.env.example`:

```bash
# Tiller Google Sheet ID — the long string in the sheet URL:
# https://docs.google.com/spreadsheets/d/<THIS_PART>/edit
TILLER_SHEET_ID=
```

**Prerequisites (from Phase 1 Gmail setup):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ENCRYPTION_KEY` must already be set. No new env vars needed for those — only `TILLER_SHEET_ID` is new.

---

## 10. Error Handling

| Scenario | Handling |
|----------|----------|
| Sheet not found / permission denied | Catch in `run()`, send user-friendly error to Telegram, log via `status.error()` |
| OAuth token expired / invalid | Token refresh is handled by googleapis client. If refresh fails, error path sends alert. |
| Empty data (no transactions in range) | Return "No transactions found for that period" — don't call Claude on empty data |
| Claude API error | Standard retry in `core/claude.js`, then error path |
| Sheets API rate limit | Unlikely at personal usage volume. If hit, standard error path. |
| Malformed sheet data | Validate header row matches expected columns. Log warning for missing columns, continue with available data. |

---

## 11. Security

- **Read-only scope only** — `spreadsheets.readonly`. No write methods in module code.
- **No secrets in logs** — sheet ID logged in audit, but no OAuth tokens or raw credentials
- **ALLOWED_CHAT_ID** — validated by router before reaching module
- **Input sanitization** — user question passed as string to Claude prompt, not executed as code
- **HTML escaping** — response sent via `telegram.send()` which uses HTML mode; Claude prompt instructs HTML entity escaping for &, <, >

---

## 12. CLAUDE.md & AGENTS.md Updates

Minor updates as part of Phase 3:

**CLAUDE.md — Stack section:**
Add: `Google Sheets API (read-only) for Tiller budget queries`

**AGENTS.md:**
No changes needed — already has "Do not write to the Tiller Google Sheet (read-only)" in the "What NOT to do" section.

---

## 13. Verification Plan

1. **OAuth setup:** Run `source .env && node scripts/modules/tiller/setup.js`, complete consent, verify `sheets_refresh_token` stored in SQLite
2. **Unit:** Manually verify `sheets-client.js` fetches correct data from the Tiller sheet
2. **Integration:** Send `$ how much did I spend this month?` via Telegram, verify response
3. **Budget check:** Send `$ am I over budget?` — verify it references Categories budget amounts
4. **Edge cases:** Send `$` with no question — verify helpful error message
5. **Weekly digest:** Trigger manually via `curl -X POST http://localhost:3000/tiller/weekly-digest`, verify Telegram output format matches spec (emoji rules, uncategorized count)
6. **n8n workflow:** Import and test schedule trigger fires correctly
7. **Error path:** Temporarily set invalid `TILLER_SHEET_ID`, verify error message sent to Telegram and `status.error()` recorded
