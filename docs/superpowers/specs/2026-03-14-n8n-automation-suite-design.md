# n8n Personal Automation Suite — Design Spec
**Date:** 2026-03-14
**Status:** Approved
**Source:** Life_Automation_Plan_v3_TrackB.docx

---

## 1. Overview

A self-hosted personal automation suite built on n8n, designed for long-term extensibility. The primary interface is a Telegram bot. All automation logic is written in Node.js and called by thin n8n workflows. A shared core library enforces consistent patterns across all modules so that new modules — built by agents or humans — behave predictably.

**Starting point:** WSL2 (Ubuntu 24.04) and Docker Desktop are installed. No n8n instance yet. This repo is the starting point.

---

## 2. Tech Stack

| Component | Role |
|-----------|------|
| n8n (Docker) | Workflow engine — scheduling, OAuth token management, trigger routing |
| Docker Compose | Runs n8n with localhost-only port binding |
| Telegram Bot API | Primary user interface — inbound commands via polling, outbound digests and alerts |
| Claude API | AI reasoning — `claude-haiku-4-5-20251001` for high-volume tasks, `claude-sonnet-4-6` for complex reasoning |
| Google OAuth 2.0 | Auth for Gmail and Google Sheets (not Google Calendar — iCloud CalDAV is used instead) |
| iCloud CalDAV | Calendar read/write via n8n community node `n8n-nodes-caldav-calendar` |
| SQLite | Local state — audit log, preferences, module health, confirmations, feedback |
| Node.js (ES modules) | All business logic — called from n8n via Code/Execute nodes |
| WSL2 (Ubuntu 24.04) | Everything runs here. Pi migration is a single rsync. |
| Tailscale | Remote access VPN — used instead of port forwarding to access n8n UI from phone |

---

## 3. Architecture

```
You (Telegram)
      │  ← Telegram uses long polling. n8n makes outbound requests only.
      ▼     No inbound ports are opened on your machine.
Telegram Bot API
      │
      ▼
n8n _router workflow          ← single entry point for all inbound messages
      │
      ├── '$...'    startsWith ──► tiller workflow
      ├── 'cal ...' startsWith ──► calendar workflow
      ├── 'gh ...'  startsWith ──► github workflow
      ├── 'news'    startsWith ──► news workflow
      ├── 'status'  exact      ──► status workflow
      └── (no match)           ──► gmail workflow (default fallback)

n8n scheduled triggers (independent of router):
  ├── 7:30 AM daily     ──► morning briefing workflow
  ├── configurable time ──► gmail digest workflow
  ├── 5:00 PM daily     ──► gmail deletion suggestions workflow
  └── Sunday 7:00 PM    ──► weekly summary workflow

Each workflow calls:
  scripts/modules/<name>/index.js
        │
        └── scripts/core/          ← shared library
            ├── telegram.js
            ├── db.js
            ├── status.js
            ├── claude.js
            └── logger.js
```

**Key principle:** n8n workflows are intentionally thin — they handle triggers, security gating, and error catching only. All business logic lives in Node.js scripts.

---

## 4. Repository Structure

```
battersoft-n8n/
├── CLAUDE.md                        # Persistent agent instructions (required contents: Section 14)
├── AGENTS.md                        # How to build a new module (required contents: Section 15)
├── CHANGELOG.md                     # All changes logged here (format: Section 16)
├── .env.example                     # All required env vars documented (format: Section 12)
├── docker-compose.yml               # n8n service definition
├── .github/
│   └── workflows/
│       ├── claude.yml               # GitHub agent (read+write)
│       └── claude-review.yml        # PR reviewer (read-only)
├── workflows/
│   ├── _router.json                 # Central Telegram router
│   └── modules/
│       ├── gmail.json
│       ├── calendar.json
│       ├── tiller.json
│       ├── news.json
│       └── github.json
├── scripts/
│   ├── core/
│   │   ├── telegram.js
│   │   ├── db.js
│   │   ├── status.js
│   │   ├── claude.js
│   │   └── logger.js
│   └── modules/
│       ├── gmail/
│       │   ├── index.js
│       │   └── prompts.js
│       ├── calendar/
│       │   ├── index.js
│       │   └── prompts.js
│       ├── tiller/
│       │   ├── index.js
│       │   └── prompts.js
│       ├── news/
│       │   ├── index.js
│       │   └── prompts.js
│       └── github/
│           ├── index.js
│           └── prompts.js
├── data/                            # gitignored
│   └── agent.db                     # SQLite database
└── docs/
    └── superpowers/
        └── specs/                   # Design docs
```

---

## 5. Core Library

The shared library is the consistency enforcement layer. Every module uses these functions — agents are not permitted to implement their own alternatives.

### 5.1 `core/telegram.js`
All Telegram I/O flows through here. Validates `ALLOWED_CHAT_ID` before every send — silently drops any message not from the allowed chat ID.

```js
send(text)                           // plain message
sendWithButtons(text, buttons)       // inline keyboard
sendDigest(sections)                 // structured digest format
reply(messageId, text)               // reply to specific message
confirm(actionId, summary)           // destructive-action gate (see confirm lifecycle below)
```

**`confirm()` lifecycle:**
1. Generates a unique `actionId` string: `${module}_${action}_${Date.now()}`
2. Inserts a row into `pending_confirmations` table with the `actionId`, module name, action description, and expiry timestamp (`now + 5 minutes`)
3. Sends a Telegram message with inline buttons: `[Confirm]` (callback_data: `confirm_${actionId}`) and `[Cancel]` (callback_data: `cancel_${actionId}`)
4. Returns a Promise that resolves `true` (confirmed) or `false` (cancelled/timed out)
5. A separate n8n Telegram Trigger workflow listens for `callback_query` events, matches `callback_data` against `pending_confirmations`, resolves the pending Promise, and calls `answerCallbackQuery` to dismiss the loading spinner
6. If expiry is reached before any response, a timeout task (polled every 60s by n8n) cleans up expired rows and sends a cancellation notice to Telegram
7. All expired or resolved rows are deleted from `pending_confirmations` — the table holds only live pending confirmations

### 5.2 `core/db.js`
SQLite wrapper. Handles connection, schema initialization, and common operations.

```js
auditLog(module, action, metadata)   // log every agent action
getPreference(key)                   // read user preference
setPreference(key, value)            // write user preference
query(sql, params)                   // general-purpose query
checkBatchSize(items, cap = 50)      // throws if items.length > cap
```

`checkBatchSize` is called before any batch operation. Hard cap is 50 items — throws an error if exceeded. If `items.length > 20`, the calling module must also call `telegram.confirm()` before proceeding with the batch.

### 5.3 `core/status.js`
Module health registry. Powers the `status` Telegram command and proactive failure alerts.

```js
heartbeat(moduleName)                // call after every successful run — resets consecutive_errors to 0
error(moduleName, errorObj)          // call on failure — increments consecutive_errors
report()                             // returns formatted status summary string
```

**Proactive alerting logic:**
- `consecutive_errors` stored in `module_status`, incremented on each `error()` call
- `heartbeat()` resets `consecutive_errors` to 0 and clears `alert_sent_at`
- When `consecutive_errors` reaches 3, fire alert: `⚠️ [moduleName] has failed 3 times in a row.\nLast error: [error.message]\nRun 'status' for details.`
- Cooldown: once alert fires, `alert_sent_at` is set. No repeat alert until `heartbeat()` is called OR 24 hours have elapsed since `alert_sent_at`
- Modules do not implement any alerting themselves — entirely inside `status.js`

### 5.4 `core/claude.js`
Claude API wrapper with retry logic and token usage logging.

```js
ask(prompt, model = 'haiku')        // model: 'haiku' | 'sonnet'
```

Model IDs:
- `'haiku'` → `claude-haiku-4-5-20251001`
- `'sonnet'` → `claude-sonnet-4-6`

Never logs prompt content. Logs token counts (input + output) to `token_log` table per call. Token log entries older than 30 days are deleted on each call (rolling retention).

### 5.5 `core/logger.js`
Structured logging to stdout (captured by Docker) and SQLite `log` table.

```js
logger.info(module, action, detail)
logger.warn(module, action, detail)
logger.error(module, action, detail)
```

---

## 6. n8n Workflow Pattern

Every module workflow follows this exact structure:

```
[Trigger or Schedule]
        │
[Validate ALLOWED_CHAT_ID]     ← always first; IF chat_id != ALLOWED_CHAT_ID → terminate, no reply
        │
[Execute Script node]          ← calls scripts/modules/<name>/index.js
        │
   ┌────┴────┐
[Error]   [Success]
   │
[Telegram error alert]         ← via core/telegram.js — sends module name + error message
```

**Rules:**
- No business logic inside n8n nodes — only trigger, validate, execute, catch
- Every workflow has an explicit error branch wired to Telegram
- Workflows are exported as JSON and committed to `workflows/modules/`
- The `_router` workflow is the only one that does intent parsing

### Router Command Prefixes

The `_router` workflow uses a Switch node on the incoming Telegram message text. All matching is case-insensitive (text is lowercased and trimmed first via a Set node before the Switch).

| Command | Match type | n8n Switch condition | Routes to |
|---------|------------|----------------------|-----------|
| `$` | startsWith | `{{ $json.text.startsWith('$') }}` | Tiller workflow |
| `cal` | startsWith | `{{ $json.text.startsWith('cal') }}` | Calendar workflow |
| `gh` | startsWith | `{{ $json.text.startsWith('gh') }}` | GitHub workflow |
| `news` | startsWith | `{{ $json.text.startsWith('news') }}` | News workflow |
| `status` | exact | `{{ $json.text === 'status' }}` | Status workflow |
| *(default)* | fallback | Switch node default output | Gmail workflow |

`$json.text` is the message body after lowercasing and trimming in the preceding Set node.

### Adding a new router entry
To add a command for a new module, add a case to the Switch node in `_router.json`:
- **Condition:** `{{ $json.text.startsWith('PREFIX') }}` (or exact: `{{ $json.text === 'COMMAND' }}`)
- **Output label:** the module name
- Wire the output to a new Execute Workflow node pointing to `workflows/modules/<name>.json`

---

## 7. Module Structure

Every module — regardless of who builds it — must follow this structure.

### Required files
```
scripts/modules/<name>/
├── index.js      # entry point called by n8n
└── prompts.js    # all Claude prompts isolated here (no prompt strings in index.js)
```

### Required `index.js` shape
```js
import { status } from '../../core/status.js'
import { logger } from '../../core/logger.js'

export async function run(input) {
  try {
    // module logic here
    await status.heartbeat('<name>')
  } catch (err) {
    await status.error('<name>', err)
    throw err  // n8n catches this → Telegram error alert
  }
}
```

### Required checklist for any new module
- [ ] `scripts/modules/<name>/index.js` using the required shape above
- [ ] `scripts/modules/<name>/prompts.js` — all Claude prompt strings live here, none in `index.js`
- [ ] `workflows/modules/<name>.json` exported from n8n and committed
- [ ] If the module has a Telegram command: new Switch node case added to `_router.json` (see Section 6 for exact condition format)
- [ ] Any new env vars added to `.env.example` using the format in Section 12
- [ ] Entry added to `CHANGELOG.md` using the format in Section 16
- [ ] Module name registered in `module_status` (happens automatically on first `heartbeat()` or `error()` call)

---

## 8. Operational Visibility

### On-demand status (Telegram `status` command)

```
🤖 System Status — Sat Mar 14, 2:30 PM

✅ gmail        last run 14m ago · 847 runs · 0 errors
✅ calendar     last run 2h ago  · 203 runs · 0 errors
⚠️ tiller       last run 3d ago  · 12 runs  · 1 error
❌ news         last run FAILED 6h ago — timeout
⬜ github       never run

Uptime: 12d · DB: 2.1MB · [View Errors] [Clear Errors]
```

Status icons: `✅` no errors in last 24h · `⚠️` errors exist but last run succeeded · `❌` last run failed · `⬜` never run

### SQLite schema

```sql
-- Module health (one row per module, upserted on each run)
CREATE TABLE module_status (
  module             TEXT PRIMARY KEY,
  last_run           INTEGER,              -- unix timestamp of last run attempt
  last_success       INTEGER,              -- unix timestamp of last successful run
  last_error         TEXT,                 -- error message from most recent failure
  run_count          INTEGER DEFAULT 0,
  error_count        INTEGER DEFAULT 0,
  consecutive_errors INTEGER DEFAULT 0,
  alert_sent_at      INTEGER               -- unix timestamp of last proactive alert, or NULL
);

-- Full audit log (every action taken by any module)
CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,                -- unix timestamp
  module  TEXT NOT NULL,
  action  TEXT NOT NULL,                   -- e.g. 'archive_email', 'create_event'
  detail  TEXT,                            -- JSON string of relevant IDs/metadata
  success INTEGER NOT NULL DEFAULT 1       -- 1 = success, 0 = failure
);

-- Error log (queryable error history)
CREATE TABLE error_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  module  TEXT NOT NULL,
  message TEXT NOT NULL,
  stack   TEXT
);

-- User preferences
CREATE TABLE preferences (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Token usage log (rolling 30-day retention, cleaned up by claude.js on each call)
CREATE TABLE token_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  module        TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL
);

-- Live pending confirmations (rows deleted when resolved or expired)
CREATE TABLE pending_confirmations (
  action_id   TEXT PRIMARY KEY,            -- e.g. 'gmail_delete_1741234567890'
  module      TEXT NOT NULL,
  description TEXT NOT NULL,               -- human-readable action summary shown to user
  expires_at  INTEGER NOT NULL             -- unix timestamp; rows older than this are cancelled
);

-- iCloud calendar mapping (populated on first CalDAV connection)
CREATE TABLE calendar_mapping (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  caldav_name   TEXT NOT NULL,             -- displayName returned by CalDAV node
  caldav_id     TEXT NOT NULL UNIQUE,      -- calendarId used for all API calls
  display_label TEXT NOT NULL,             -- user-facing name, e.g. 'Kids'
  emoji         TEXT,
  display_order INTEGER DEFAULT 0,
  owner_label   TEXT                       -- e.g. 'Garrett', 'Family'
);
```

### Proactive alerting

Fully implemented in `core/status.js`. See Section 5.3 for complete logic. Modules do not implement any alerting themselves.

---

## 9. Security — Local Network Exposure

**This section is critical.** n8n runs inside Docker on WSL2. By default, Docker binds ports to `0.0.0.0`, making your n8n UI reachable from every device on your local network. This is the primary attack surface to lock down.

### Docker port binding (most important)

In `docker-compose.yml`, always bind n8n to localhost only:

```yaml
services:
  n8n:
    ports:
      - "127.0.0.1:5678:5678"   # ← bind to localhost ONLY, not 0.0.0.0
```

This means n8n is only reachable from within your machine. The Windows Firewall and any LAN devices cannot reach port 5678.

### Telegram uses polling — no inbound ports needed

The Telegram Trigger node in n8n uses long polling: n8n makes outbound HTTPS requests to `api.telegram.org`. **No inbound port is opened on your machine.** This is the safest possible configuration — Telegram never connects to you.

Consequence: do not configure n8n Telegram nodes as webhooks. Use polling mode only.

### n8n basic auth

Enable n8n's built-in basic authentication so the web UI at `http://localhost:5678` requires a login:

```yaml
# in docker-compose.yml environment:
N8N_BASIC_AUTH_ACTIVE: "true"
N8N_BASIC_AUTH_USER: admin
N8N_BASIC_AUTH_PASSWORD: ${N8N_BASIC_AUTH_PASSWORD}  # set in .env
```

This prevents access if something else on the machine can reach the port.

### Remote access via Tailscale (not port forwarding)

To access n8n from your phone or another device:
1. Install Tailscale on Windows (`tailscale.com/download`) — free personal plan
2. Install Tailscale on your phone
3. Access n8n via your Tailscale IP: `http://100.x.x.x:5678`

**Never use port forwarding on your router.** Exposing n8n directly to the internet is a serious security risk.

### Windows Firewall rules

Docker Desktop on WSL2 automatically creates Windows Firewall rules when containers start. Verify these are not allowing inbound from public networks:
- Open Windows Defender Firewall > Advanced Settings
- Check Inbound Rules for any Docker-related rules scoped to "Public" network profile
- If found, change scope to "Private" or remove entirely (the localhost binding in docker-compose is the real protection)

### Summary of attack surface

| Vector | Mitigation |
|--------|------------|
| n8n UI reachable from LAN | `127.0.0.1:5678` binding in docker-compose |
| n8n UI brute-forced locally | Basic auth with strong password |
| Telegram bot responds to anyone | `ALLOWED_CHAT_ID` validation on every inbound message |
| n8n credential vault exposed | `N8N_ENCRYPTION_KEY` stored only in `.env` (never committed) |
| Google OAuth tokens leaked | Stored in n8n vault only, never logged |
| iCloud password exposed | App-specific password only; revocable at appleid.apple.com |
| Secrets in git | `.env` is gitignored; `.env.example` contains no values |
| Inbound webhook attack | Not applicable — Telegram uses polling only |

---

## 10. Additional Security Rules (Application Layer)

| Area | Rule |
|------|------|
| Secrets | All secrets via environment variables only — never hardcoded, never in logs |
| Google OAuth | Tokens in n8n vault. Never logged or exposed in error messages. |
| Sheets API | Scope: `https://www.googleapis.com/auth/spreadsheets.readonly` only. Core layer rejects any write call. |
| Gmail API | Scopes: `https://www.googleapis.com/auth/gmail.modify` + `https://www.googleapis.com/auth/gmail.send`. The `gmail.modify` scope covers moving emails to Trash (the standard delete path — emails are permanently removed by Google after 30 days). The `https://mail.google.com/` full-access scope is never requested. |
| CalDAV | App-specific password only — generated at `appleid.apple.com`. Never use Apple ID password. |
| Destructive actions | These operations require Telegram confirmation before executing: email deletion (moved to Trash via `gmail.modify`), calendar event deletion or modification, batch archive of any size. The daily 5 PM deletion prompt (see below) uses a multi-item `sendWithButtons()` format for batch confirmation rather than individual `confirm()` calls. Auto-cancelled after 5 min with no response. |
| Batch operations | `db.checkBatchSize(items)` before every batch. Hard cap: 50 items. Secondary confirm required if >20 items. Applies to Gmail and GitHub batches. |

### Daily 5 PM Email Deletion Prompt

Every day at 5 PM, the Gmail module sends a Telegram message listing emails it suggests deleting (promotional >30 days, social notifications >30 days, automated receipts >1 year). Format:

```
🗑 Deletion suggestions — 12 emails

1. Promo: "20% off this weekend" — Gap, Mar 1
2. Promo: "Your cart is waiting" — Amazon, Feb 28
3. Notification: "John liked your post" — LinkedIn, Feb 20
... (up to 50 per batch)

[Delete All] [Review List] [Skip Today]
```

- **[Delete All]** moves all listed emails to Trash in one batch operation (guarded by `checkBatchSize`)
- **[Review List]** sends individual items with per-item `[Trash]` / `[Keep]` buttons
- **[Skip Today]** dismisses without action
- Auto-dismissed after 5 minutes with no response (no action taken)
- Uses `gmail.modify` scope — emails moved to Trash, permanently deleted by Google after 30 days
- Starred emails, emails <30 days old, and emails in custom user labels are never included
| Audit trail | Every agent action logged via `db.auditLog()` with timestamp, module, action, item IDs. |

---

## 11. iCloud CalDAV Integration

**Note:** This system uses iCloud CalDAV for all calendar operations — not Google Calendar. No Google Calendar OAuth scope is required.

**Endpoint:** `https://caldav.icloud.com`

**Authentication:** Basic Auth — Apple ID email as username, app-specific password as password.
- Generate app-specific password: `appleid.apple.com > Security > App-Specific Passwords`
- Store in n8n as a "Header Auth" credential: `Authorization: Basic <base64(email:app-password)>`

**Community node:** `n8n-nodes-caldav-calendar`
- npm: `https://www.npmjs.com/package/n8n-nodes-caldav-calendar`
- Install via n8n: Settings > Community nodes > Install > enter `n8n-nodes-caldav-calendar`
- Pin the version used in `docker-compose.yml` or n8n community node settings. Check the npm page for the latest stable version before installing. Do not install alpha/beta versions.

**Calendar discovery:** On first connection, call the node's list-calendars operation. Returns objects with `displayName` and `calendarId` — store both in the `calendar_mapping` SQLite table (schema in Section 8).

---

## 12. Modules (Planned)

| Phase | Module | Core Function |
|-------|--------|---------------|
| 0 | Infrastructure | n8n, Docker, Telegram bot, core library, SQLite |
| 1 | Gmail Agent | Email classification, auto-archiving, daily digest, LinkedIn replies, daily 5 PM deletion prompt |
| 2 | Calendar | iCloud CalDAV read/write, natural language parsing, conflict detection |
| 3 | Tiller Budget | Google Sheets read-only Q&A, weekly spending summaries |
| 4 | News Briefing | RSS aggregation, Claude curation, personalization via feedback |
| 5 | GitHub Agent | Issue-to-PR automation via Claude Code GitHub Action |

**Deferred — out of scope until Phases 0–4 are stable:**

> **Second Me (Optional):** Local LLM voice layer for draft generation using Qwen2.5-7B on the 4070 Ti (12GB VRAM). Routes LinkedIn/email drafts through a local model before Claude review. Do not implement or scaffold this until all primary phases are running reliably. A separate spec will be written when prioritized.

---

## 13. Environment Variables

All env vars in `.env.example` use this format — one var per block, comment above each, no values set:

```bash
# Telegram bot token — get from @BotFather via /newbot
TELEGRAM_BOT_TOKEN=

# Your personal Telegram chat ID — all other senders are silently rejected
# Get it: send any message to your bot, then call:
# curl https://api.telegram.org/bot<TOKEN>/getUpdates
ALLOWED_CHAT_ID=

# n8n web UI port
N8N_PORT=5678

# n8n encryption key for credential vault
# Generate: openssl rand -hex 32
# CRITICAL: back this up. If lost, all stored OAuth tokens must be re-entered.
# Never commit the actual value.
N8N_ENCRYPTION_KEY=

# n8n basic auth (secures the web UI at localhost:5678)
N8N_BASIC_AUTH_PASSWORD=

# Anthropic API key — https://console.anthropic.com
ANTHROPIC_API_KEY=

# Absolute path to SQLite database file inside WSL2 filesystem
DB_PATH=/home/<your-user>/life-automation/data/agent.db

# Google OAuth is managed via n8n credential vault — no env vars needed here
# iCloud CalDAV is managed via n8n credential vault — no env vars needed here
```

---

## 14. Infrastructure Setup (Phase 0 Checklist)

Each step includes the expected verification so an agent can confirm success before proceeding.

1. **Generate secrets**
   - `openssl rand -hex 32` → paste as `N8N_ENCRYPTION_KEY` in `.env`
   - Choose a strong password → paste as `N8N_BASIC_AUTH_PASSWORD` in `.env`
   - Verify: `.env` file exists, not committed (`git status` shows it gitignored)

2. **Create `docker-compose.yml`** with n8n service using `127.0.0.1:${N8N_PORT}:5678` port binding and env vars from `.env`
   - Verify: `docker compose config` returns no errors

3. **Deploy n8n:** `docker compose up -d`
   - Verify: `docker ps` shows n8n container running
   - Verify: `curl -s http://localhost:5678/healthz` returns `{"status":"ok"}`
   - Verify: `curl -s http://localhost:5678` prompts for basic auth (401 without credentials)

4. **Create Telegram bot** via @BotFather → `/newbot`
   - Set `TELEGRAM_BOT_TOKEN` in `.env`
   - Send any message to the bot
   - Run: `curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"` → find your chat ID in the response
   - Set `ALLOWED_CHAT_ID` in `.env`

5. **Set up Google Cloud project**
   - Go to `console.cloud.google.com`, create a new project
   - Enable APIs: **Gmail API** and **Google Sheets API** (not Google Calendar — CalDAV handles calendar)
   - Create OAuth 2.0 credentials (Desktop app type), download client JSON
   - Verify: both APIs show as "Enabled" in the APIs & Services dashboard

6. **Configure Google OAuth in n8n**
   - Add Gmail OAuth2 credential in n8n using client JSON from Step 5
     - Scopes: `https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send`
   - Add Google Sheets OAuth2 credential
     - Scope: `https://www.googleapis.com/auth/spreadsheets.readonly`
   - Verify: both credentials show green "Connected" status in n8n

7. **Install CalDAV community node**
   - n8n Settings > Community nodes > Install > `n8n-nodes-caldav-calendar`
   - Generate iCloud app-specific password at `appleid.apple.com`
   - Create Header Auth credential in n8n: `Authorization: Basic <base64(email:app-password)>`
   - Test list-calendars operation
   - Verify: operation returns your iCloud calendar list

8. **Initialize SQLite database**
   - Run all `CREATE TABLE` statements from Section 8
   - Verify: `sqlite3 ${DB_PATH} ".tables"` lists all 8 tables

9. **Build core library**
   - Implement all five files in `scripts/core/`
   - Verify: `node -e "import('./scripts/core/telegram.js').then(m => m.send('test'))"` delivers a message to your Telegram

10. **Build `_router` workflow**
    - Create n8n workflow with Telegram Trigger (polling mode) → Set node (lowercase+trim text) → Switch node (all prefixes from Section 6) → module stubs
    - Export and commit as `workflows/_router.json`

11. **End-to-end smoke test**
    - Send `status` to the Telegram bot
    - Expected: status message showing all modules as `⬜ never run`
    - Verify: message arrives within ~30 seconds, format matches Section 8 example

---

## 15. Required `CLAUDE.md` Contents

```markdown
# CLAUDE.md — battersoft-n8n

## Project Overview
n8n-based personal automation suite. Self-hosted on WSL2 with Docker.
Telegram bot is the primary interface. Claude API handles all AI reasoning.
All business logic is in scripts/. n8n workflows are thin trigger/error wrappers.

## Stack
- n8n workflows (JSON in /workflows/)
- Node.js ES modules for all logic (/scripts/)
- SQLite for local state (/data/agent.db)
- Docker Compose — port bound to 127.0.0.1 only

## Coding Standards
- All secrets via environment variables only — never hardcoded
- Every n8n workflow must have an error branch wired to Telegram
- All agent actions logged via db.auditLog() before and after execution
- Confirm destructive actions via telegram.confirm() before executing
- All Claude prompts live in prompts.js, never inline in index.js

## Core Library (always use these — never reimplement)
- core/telegram.js — all Telegram I/O including confirm()
- core/db.js — all SQLite operations, checkBatchSize()
- core/status.js — heartbeat() and error() on every run
- core/claude.js — ask(prompt, model?) for all Claude calls
- core/logger.js — logger.info/warn/error for all logging

## Before Opening a PR
- Export updated n8n workflows to workflows/ directory
- Add entry to CHANGELOG.md
- Document any new env vars in .env.example
- Confirm no secrets in code or logs

## Security Rules
- Google OAuth tokens: never log, never expose in error messages
- Telegram: ALLOWED_CHAT_ID validated on every inbound message
- CalDAV: app-specific password only, never Apple ID password
- Sheets API: read-only scope — reject any write attempt
- Telegram polling only — never configure webhook mode
```

---

## 16. Required `AGENTS.md` Contents

```markdown
# AGENTS.md — Building a New Module

## What a module is
A module = one Node.js directory (scripts/modules/<name>/) + one n8n workflow (workflows/modules/<name>.json).

## Step-by-step checklist

1. Create scripts/modules/<name>/index.js:
   import { status } from '../../core/status.js'
   import { logger } from '../../core/logger.js'
   export async function run(input) {
     try {
       // your logic
       await status.heartbeat('<name>')
     } catch (err) {
       await status.error('<name>', err)
       throw err
     }
   }

2. Create scripts/modules/<name>/prompts.js with all Claude prompt strings.
   Do not put prompt strings in index.js.

3. Build the n8n workflow (thin: trigger → validate → execute → error branch).
   Export as workflows/modules/<name>.json.

4. If the module responds to a Telegram command, add a Switch node case to
   workflows/_router.json. See design spec Section 6 for exact condition format.

5. Add new env vars to .env.example (format: comment above each var, no value set).

6. Add a CHANGELOG.md entry (format: Section 16 of design spec).

## Core library reference
- telegram.send(text)
- telegram.sendWithButtons(text, buttons)
- telegram.confirm(actionId, summary) — REQUIRED before any destructive action
- db.auditLog(module, action, metadata)
- db.checkBatchSize(items) — REQUIRED before any batch operation
- status.heartbeat(name) — call on success
- status.error(name, err) — call on failure
- claude.ask(prompt, model?) — 'haiku' (default) or 'sonnet'
- logger.info/warn/error(module, action, detail)

## Destructive actions — always use telegram.confirm() first
- Email deletion
- Calendar event deletion or modification
- Any batch archive operation (any size)

## What NOT to do
- Do not write Telegram send logic outside telegram.js
- Do not put Claude prompts inline in index.js
- Do not hardcode secrets
- Do not write to the Tiller Google Sheet (read-only)
- Do not open inbound ports or configure Telegram webhooks
- Do not push directly to main — open a PR
```

---

## 17. `CHANGELOG.md` Format

Every module addition or change requires a CHANGELOG entry. Use this format:

```markdown
## [Unreleased]

### Added
- Module: gmail — email classification, daily digest, LinkedIn replies
- Core: telegram.confirm() for destructive action gating

### Changed
- Router: added 'gh' prefix for GitHub module

### Fixed
- Status: consecutive_errors not resetting on heartbeat
```

Follow [Keep a Changelog](https://keepachangelog.com) conventions: `Added`, `Changed`, `Fixed`, `Removed`. Add entries under `[Unreleased]`; version and date when a release is tagged.

---

## 18. Pi Migration Path

Full migration procedure from WSL2 to Raspberry Pi 4/5:

```bash
# Step 1: sync entire project (including SQLite database) from WSL2
rsync -av ~/life-automation/ pi@raspberrypi.local:~/life-automation/

# Step 2: copy .env separately (not in git)
scp ~/life-automation/.env pi@raspberrypi.local:~/life-automation/.env

# Step 3: on the Pi — start services
cd ~/life-automation && docker compose up -d
```

**N8N_ENCRYPTION_KEY must be identical on the Pi.** It is copied in Step 2 via the `.env` file. If this key ever changes, every credential stored in n8n must be re-entered from scratch.

**Post-migration tasks (one-time):**
1. Re-authorize Google OAuth tokens — they are tied to the originating machine's token exchange. Go to n8n credentials and reconnect each Google account.
2. Verify iCloud CalDAV credential works — test list-calendars in n8n.
3. Telegram bot token is portable — no change needed.
4. Run `status` in Telegram to confirm all modules show correct last-run times.

**The SQLite database transfers as-is** — all history, preferences, confirmations, and calendar mappings are preserved.

---

*Built with Claude AI — design approved 2026-03-14*
