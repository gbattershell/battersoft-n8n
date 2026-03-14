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
| n8n (Docker) | Workflow engine — scheduling, webhooks, OAuth token management, trigger routing |
| Docker Compose | Runs n8n and any supporting services |
| Telegram Bot API | Primary user interface — inbound commands, outbound digests and alerts |
| Claude API | AI reasoning — haiku for high-volume tasks, sonnet for complex reasoning |
| Google OAuth 2.0 | Auth for Gmail and Google Sheets |
| iCloud CalDAV | Calendar read/write via n8n community node |
| SQLite | Local state — audit log, preferences, module health, feedback |
| Node.js (ES modules) | All business logic — called from n8n via Code/Execute nodes |
| WSL2 (Ubuntu 24.04) | Everything runs here. Pi migration is a single rsync. |

---

## 3. Architecture

```
You (Telegram)
      │
      ▼
Telegram Bot API
      │
      ▼
n8n _router workflow          ← single entry point for all inbound messages
      │
      ├── intent: '$'    ──► tiller workflow
      ├── intent: 'cal'  ──► calendar workflow
      ├── intent: 'status' ► status workflow
      ├── intent: 'news' ──► news workflow
      └── intent: (other) ► gmail workflow

n8n scheduled triggers (independent of router):
  ├── 7:30 AM daily    ──► morning briefing workflow
  ├── configurable time ─► gmail digest workflow
  └── Sunday evening   ──► weekly summary workflow

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

**Key principle:** n8n workflows are intentionally thin — they handle triggers, security gating, and error catching only. All business logic lives in Node.js scripts. This separation means module logic can be tested independently and agents follow a single consistent pattern.

---

## 4. Repository Structure

```
battersoft-n8n/
├── CLAUDE.md                        # Persistent agent instructions
├── AGENTS.md                        # How to build a new module (agents read this)
├── CHANGELOG.md                     # All changes logged here
├── .env.example                     # All required env vars documented
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
All Telegram I/O flows through here. Validates `ALLOWED_CHAT_ID` before every send.

```js
send(text)                          // plain message
sendWithButtons(text, buttons)      // inline keyboard
sendDigest(sections)                // structured digest format
reply(messageId, text)              // reply to specific message
```

### 5.2 `core/db.js`
SQLite wrapper. Handles connection, migrations, and common operations.

```js
auditLog(module, action, metadata)  // log every agent action
getPreference(key)                  // read user preference
setPreference(key, value)           // write user preference
query(sql, params)                  // general-purpose query
```

### 5.3 `core/status.js`
Module health registry. Powers the `status` Telegram command and proactive failure alerts.

```js
heartbeat(moduleName)               // call after every successful run
error(moduleName, error)            // call on failure
report()                            // returns formatted status summary
```

Proactive alerting: if any module fails 3 consecutive runs, `status.js` automatically sends a Telegram alert. Modules do not implement this themselves.

### 5.4 `core/claude.js`
Claude API wrapper with retry logic and token usage logging.

```js
ask(prompt, model = 'haiku')        // 'haiku' or 'sonnet'
```

Never logs prompt content. Logs token counts to SQLite.

### 5.5 `core/logger.js`
Structured logging to stdout (Docker) and SQLite.

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
[Validate ALLOWED_CHAT_ID]     ← always first, hard security gate
        │
[Execute Script node]          ← calls scripts/modules/<name>/index.js
        │
   ┌────┴────┐
[Error]   [Success]
   │
[Telegram error alert]         ← via core/telegram.js
```

**Rules:**
- No business logic inside n8n nodes — only trigger, validate, execute, catch
- Every workflow has an explicit error branch wired to Telegram
- Workflows are exported as JSON and committed to `workflows/modules/`
- The `_router` workflow is the only one that does intent parsing

### Router Command Prefixes

| Prefix | Module |
|--------|--------|
| `$` | Tiller Budget |
| `cal` | Calendar |
| `status` | Health report |
| `news` | News briefing |
| *(unmatched)* | Gmail fallback |

---

## 7. Module Structure

Every module — regardless of who builds it — must follow this structure.

### Required files
```
scripts/modules/<name>/
├── index.js      # entry point called by n8n
└── prompts.js    # all Claude prompts isolated here
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
- [ ] `scripts/modules/<name>/index.js` with the required shape above
- [ ] `scripts/modules/<name>/prompts.js` with all Claude prompts
- [ ] `workflows/modules/<name>.json` exported from n8n
- [ ] Router entry added to `_router.json` if the module has a Telegram command
- [ ] New env vars documented in `.env.example`
- [ ] Entry added to `CHANGELOG.md`

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

### SQLite schema

```sql
-- Module health (one row per module, upserted on each run)
CREATE TABLE module_status (
  module       TEXT PRIMARY KEY,
  last_run     INTEGER,          -- unix timestamp
  last_error   TEXT,
  run_count    INTEGER DEFAULT 0,
  error_count  INTEGER DEFAULT 0,
  consecutive_errors INTEGER DEFAULT 0
);

-- Full audit log
CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  module  TEXT NOT NULL,
  action  TEXT NOT NULL,
  detail  TEXT,
  success INTEGER DEFAULT 1
);

-- Error log
CREATE TABLE error_log (
  id      INTEGER PRIMARY KEY,
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
```

### Proactive alerting

`core/status.js` tracks consecutive errors per module. On the 3rd consecutive failure, it sends a Telegram alert automatically — no polling or manual checking needed.

---

## 9. Security Rules

| Area | Rule |
|------|------|
| Telegram | Validate `ALLOWED_CHAT_ID` on every inbound message. Reject all others silently. |
| Secrets | All secrets via environment variables only — never hardcoded, never in logs |
| Google OAuth | Tokens stored in n8n's encrypted credential vault. Never logged. |
| Sheets API | Read-only scope enforced. Reject any write attempts at the core layer. |
| CalDAV | App-specific password only, never Apple ID password |
| Destructive actions | Always require Telegram [Confirm] button before executing |
| Batch operations | Cap at 50 items per run. Second confirmation for >20 items. |
| Audit trail | Every agent action logged to SQLite with timestamp, module, action, item IDs |

---

## 10. Modules (Planned)

All modules follow the patterns above. Implementation order follows the phased roadmap.

| Phase | Module | Core Function |
|-------|--------|---------------|
| 0 | Infrastructure | n8n, Docker, Telegram bot, core library, SQLite |
| 1 | Gmail Agent | Email classification, auto-archiving, daily digest, LinkedIn replies |
| 2 | Calendar | iCloud CalDAV read/write, natural language parsing, conflict detection |
| 3 | Tiller Budget | Google Sheets read-only Q&A, weekly spending summaries |
| 4 | News Briefing | RSS aggregation, Claude curation, personalization via feedback |
| 5 | GitHub Agent | Issue-to-PR automation via Claude Code GitHub Action |
| Optional | Second Me | Local LLM voice layer for draft generation (Qwen2.5-7B on 4070 Ti) |

---

## 11. Infrastructure Setup (Phase 0 Checklist)

1. Create `docker-compose.yml` with n8n service
2. Deploy n8n: `docker compose up -d` — verify at `http://localhost:5678`
3. Create Telegram bot via @BotFather, capture bot token and personal chat ID
4. Set up Google Cloud project, enable Gmail API and Sheets API
5. Configure OAuth credentials, connect both Gmail accounts in n8n
6. Install `n8n-nodes-caldav-calendar` community node
7. Initialize SQLite database with schema above
8. Build and test core library (telegram, db, status, claude, logger)
9. Build `_router` workflow with command prefix routing
10. Test: `status` command returns health report via Telegram

---

## 12. Environment Variables

All required variables (full list in `.env.example`):

```
# n8n
N8N_PORT=5678
N8N_ENCRYPTION_KEY=

# Telegram
TELEGRAM_BOT_TOKEN=
ALLOWED_CHAT_ID=

# Claude
ANTHROPIC_API_KEY=

# SQLite
DB_PATH=./data/agent.db

# Google (managed via n8n OAuth, not env vars)
# iCloud (managed via n8n credential, not env vars)
```

---

## 13. Pi Migration Path

Because everything runs in standard Linux inside WSL2, migration to a Raspberry Pi 4/5 is:

```bash
# From WSL2:
rsync -av ~/life-automation/ pi@raspberrypi.local:~/life-automation/
# On Pi:
cd ~/life-automation && docker compose up -d
```

The only post-migration task is re-authorizing Google OAuth tokens. All else transfers as-is.

---

*Built with Claude AI — design approved 2026-03-14*
