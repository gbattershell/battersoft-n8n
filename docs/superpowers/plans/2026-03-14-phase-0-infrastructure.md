# Phase 0: Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a fully working n8n automation infrastructure: Docker/n8n deployment, shared Node.js core library, Telegram bot router, and end-to-end status command — so every subsequent module has a solid foundation to build on.

**Architecture:** n8n runs in Docker (localhost-only port binding). All business logic lives in Node.js ES modules under `scripts/`. A shared core library (`db`, `logger`, `telegram`, `status`, `claude`) enforces consistent patterns across all modules. Telegram uses polling — no inbound ports opened.

**Tech Stack:** Node.js 20+ (ES modules), better-sqlite3, @anthropic-ai/sdk, Docker Compose, n8n, Telegram Bot API (raw fetch)

**Spec:** `docs/superpowers/specs/2026-03-14-n8n-automation-suite-design.md`

---

## Carry-Forward Issues

Issues flagged during code review that must be addressed in a future task. Implementers: read this section before starting your task.

### Minor findings — review at end of all tasks (yes/no on addressing each)

- **[Task 2] CHANGELOG.md example is thin**: Only one entry exists as a template. Future agents following it may produce sparse changelogs.
- **[Task 4] No foreign key constraints**: Implicit relationships between tables (e.g. `audit_log.module` → `module_status.module`) are not enforced by SQLite FK constraints. Acceptable for a personal tool, but not obvious to future contributors.
- **[Task 5] `getDb()` re-execs schema.sql on every cold start**: `CREATE TABLE IF NOT EXISTS` makes it idempotent, but it's a redundant filesystem read + DDL batch for already-initialized databases.
- **[Task 5] No `closeDb()` export**: The `_db` singleton can't be reset in tests. Future tests needing to test connection-closed or schema re-init paths have no hook.
- **[Task 5] `auditLog` hardcodes `success = 1`**: No way to record a failed action. Pre-execution audit entries are logged as success before the outcome is known.
- **[Task 7] `answerCallbackQuery` has no test**: The spinner-dismiss call in the callback handler. If it breaks, users see a spinning Telegram button indefinitely.
- **[Task 7] `requestConfirmation` test doesn't assert `expires_at`**: The 5-minute timeout field is never verified in tests — a regression could go undetected.
- **[Task 7] `send`/`reply` HTML parse_mode undocumented for callers**: Both always use `parse_mode: 'HTML'`. Module authors passing raw user/API data with `<`, `>`, `&` could produce garbled or rejected messages. Not documented at the function level.
- **[Task 8] Error detail truncated to 40 chars in `❌` report line**: May silently cut off useful error context mid-word.
- **[Task 8] No JSDoc on exported functions in status.js**: `heartbeat`, `error`, `report` have no parameter/return type documentation.
- **[Task 9] `claude.js` error message statically lists models**: "Use 'haiku' or 'sonnet'" is hardcoded — won't update automatically if a model is added to `MODEL_IDS`.

### Addressed inline (not a future task)

- **`query`/`queryOne`/`run` require array params** (`scripts/core/db.js`): `better-sqlite3` accepts a single array for bind parameters. Passing a scalar silently misbinds. Added a warning comment directly above those functions in db.js. All callers must pass `['value']` not `'value'`. *(Documented in code — no future task needed.)*

### To address in Task 13 (callback-handler)

- **`requestConfirmation` DB failure is unlogged** (`scripts/core/telegram.js`): The synchronous `dbRun(...)` call inside `requestConfirmation` has no error handling. If it throws (schema mismatch, disk full), the exception propagates silently with no log entry. Wrap with try/catch and log via `logger.error` before re-throwing.

- **`requestConfirmation` return value is undocumented** (`scripts/core/telegram.js`): The spec describes a Promise-based resolution (boolean), but the n8n callback design makes that impractical. The function currently returns `undefined`. Add a JSDoc comment explicitly stating: resolution is handled by the callback-handler workflow, not by awaiting this call.

---

## File Map

| File | Responsibility |
|------|---------------|
| `package.json` | Node.js project config and dependencies |
| `.gitignore` | Exclude data/, .env, node_modules |
| `.env.example` | All env var documentation |
| `docker-compose.yml` | n8n service with localhost-only binding and basic auth |
| `CLAUDE.md` | Agent instructions (from spec Section 15) |
| `AGENTS.md` | Module-building guide (from spec Section 16) |
| `CHANGELOG.md` | Change history |
| `scripts/db/schema.sql` | All CREATE TABLE statements |
| `scripts/db/init.js` | One-time schema initializer script |
| `scripts/core/db.js` | SQLite wrapper — all DB operations |
| `scripts/core/logger.js` | Structured stdout logging |
| `scripts/core/telegram.js` | All Telegram I/O + confirm lifecycle |
| `scripts/core/status.js` | Module health registry + proactive alerts |
| `scripts/core/claude.js` | Claude API wrapper with token logging |
| `tests/core/db.test.js` | Tests for db.js |
| `tests/core/telegram.test.js` | Tests for telegram.js |
| `tests/core/status.test.js` | Tests for status.js |
| `tests/core/claude.test.js` | Tests for claude.js |
| `workflows/_router.json` | Central Telegram routing workflow (built in n8n UI) |
| `workflows/modules/status.json` | Status report workflow (built in n8n UI) |
| `workflows/system/callback-handler.json` | Confirm/cancel button handler (built in n8n UI) |
| `workflows/system/confirm-timeout.json` | Expired confirmation cleanup (built in n8n UI) |

---

## Chunk 0: Move Repo to WSL Filesystem

**Do this first.** The spec requires all project files to live inside the WSL2 filesystem (e.g. `~/life-automation/`), not under `/mnt/c/`. Docker volume mounts on Windows-mounted paths are significantly slower, and the Pi migration path (`rsync`) only works reliably from the WSL-native filesystem.

### Task 0: Migrate repo from Windows mount to WSL filesystem

**Files:** No new files — this is a filesystem move.

- [ ] **Step 1: Copy repo to WSL-native path**

```bash
# From inside WSL2 terminal:
cp -r /mnt/c/Users/Garrett/codebase/battersoft-n8n ~/life-automation
```

Expected: `~/life-automation/` exists and contains `.git/`, `docs/`, `Life_Automation_Plan_v3_TrackB.docx`.

- [ ] **Step 2: Verify git history is intact**

```bash
cd ~/life-automation
git log --oneline
```

Expected: same commit history as before (3 commits visible).

- [ ] **Step 3: Update VS Code to open from WSL path**

If using VS Code on Windows, run from the WSL2 terminal:
```bash
cd ~/life-automation && code .
```

This opens VS Code pointing at the WSL path. All subsequent work happens here.

- [ ] **Step 4: Verify Claude Code working directory**

If running Claude Code, ensure it is invoked from `~/life-automation/` inside WSL2, not from the Windows mount path.

- [ ] **Step 5: Create the data directory**

```bash
mkdir -p ~/life-automation/data
```

- [ ] **Step 6: (Optional) Remove the Windows-side copy after confirming the WSL copy is correct**

Only do this once you've verified everything works from `~/life-automation/`. The Windows copy at `/mnt/c/Users/Garrett/codebase/battersoft-n8n` can be deleted from Windows Explorer.

---

## Chunk 1: Repo Scaffold

### Task 1: Node.js project files

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "battersoft-n8n",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test tests/**/*.test.js",
    "db:init": "node scripts/db/init.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "better-sqlite3": "^11.0.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
data/
.env
*.db
```

- [ ] **Step 3: Create `.env.example`**

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

- [ ] **Step 4: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, `package-lock.json` created, no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore .env.example
git commit -m "feat: Node.js project scaffold"
```

---

### Task 2: Root documentation files

**Files:**
- Create: `CLAUDE.md`
- Create: `AGENTS.md`
- Create: `CHANGELOG.md`

- [ ] **Step 1: Create `CLAUDE.md`**

Note: the `requestConfirmation()` signature below reflects the actual implementation (spec's `confirm()` was underspecified — see Task 7 for full signature).

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
- Confirm destructive actions via telegram.requestConfirmation() before executing
- All Claude prompts live in prompts.js, never inline in index.js

## Core Library (always use these — never reimplement)
- core/telegram.js — all Telegram I/O including requestConfirmation()
- core/db.js — all SQLite operations, checkBatchSize()
- core/status.js — heartbeat() and error() on every run
- core/claude.js — ask(prompt, model?, { module? }) for all Claude calls
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

- [ ] **Step 2: Create `AGENTS.md`**

```markdown
# AGENTS.md — Building a New Module

## What a module is
A module = one Node.js directory (scripts/modules/<name>/) + one n8n workflow (workflows/modules/<name>.json).

## Step-by-step checklist

1. Create scripts/modules/<name>/index.js:
   ```js
   import { heartbeat, error as statusError } from '../../core/status.js'
   import { logger } from '../../core/logger.js'
   export async function run(input) {
     try {
       // your logic
       await heartbeat('<name>')
     } catch (err) {
       await statusError('<name>', err)
       throw err
     }
   }
   ```

2. Create scripts/modules/<name>/prompts.js with all Claude prompt strings.
   Do not put prompt strings in index.js.

3. Build the n8n workflow (thin: trigger → validate → execute → error branch).
   Export as workflows/modules/<name>.json.

4. If the module responds to a Telegram command, add a Switch node case to
   workflows/_router.json. Two condition forms:
   - Prefix match: `{{ $json.text.startsWith('PREFIX') }}`
   - Exact match:  `{{ $json.text === 'COMMAND' }}`
   See design spec Section 6 for the full routing table and Switch node setup.
   Wire output to Execute Workflow node for your module.

5. Add new env vars to .env.example (comment above each var, no value set).

6. Add a CHANGELOG.md entry (see CHANGELOG.md for format).

## Core library reference
- telegram.send(text)
- telegram.sendWithButtons(text, buttons)
- telegram.requestConfirmation({ actionId, description, callbackModule, callbackAction, callbackParams })
- db.auditLog(module, action, metadata)
- db.checkBatchSize(items) — call before any batch operation
- status.heartbeat(name) — call on success
- status.error(name, err) — call on failure
- claude.ask(prompt, model?, { module? }) — model: 'haiku' (default) or 'sonnet'
- logger.info/warn/error(module, action, detail)

## Destructive actions — always use requestConfirmation() first
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

- [ ] **Step 3: Create `CHANGELOG.md`**

```markdown
# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com) — Added / Changed / Fixed / Removed.

## [Unreleased]

### Added
- Phase 0: infrastructure scaffold, Docker/n8n, core library, Telegram router
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md CHANGELOG.md
git commit -m "feat: add CLAUDE.md, AGENTS.md, CHANGELOG.md"
```

---

## Chunk 2: Docker + n8n Deployment

### Task 3: docker-compose.yml and live n8n

**Files:**
- Create: `docker-compose.yml`
- Create: `.env` (not committed — user fills in values)

- [ ] **Step 1: Generate secrets and create `.env`**

```bash
# Generate encryption key
openssl rand -hex 32
```

Copy the output. Then create `.env` by copying `.env.example` and filling in:
- `N8N_ENCRYPTION_KEY` — paste the generated key
- `N8N_BASIC_AUTH_PASSWORD` — choose a strong password (≥16 chars)
- `TELEGRAM_BOT_TOKEN` — from @BotFather (or leave blank for now, fill after Task 3 Step 4)
- `ALLOWED_CHAT_ID` — leave blank for now
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `DB_PATH` — e.g. `/home/garrett/life-automation/data/agent.db`

Verify `.env` is gitignored:
```bash
git status
```
Expected: `.env` does NOT appear in the output.

- [ ] **Step 2: Create `docker-compose.yml`**

Before creating this file, check https://hub.docker.com/r/n8nio/n8n/tags for the latest stable version tag and replace `X.Y.Z` below.

```yaml
services:
  n8n:
    # Pin to a specific version — check hub.docker.com/r/n8nio/n8n/tags for latest stable
    image: n8nio/n8n:X.Y.Z
    restart: unless-stopped
    ports:
      # Bind to localhost only — never expose to LAN (spec Section 9)
      - "127.0.0.1:${N8N_PORT:-5678}:5678"
    environment:
      - N8N_BASIC_AUTH_ACTIVE=true
      - N8N_BASIC_AUTH_USER=admin
      - N8N_BASIC_AUTH_PASSWORD=${N8N_BASIC_AUTH_PASSWORD}
      - N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}
    volumes:
      - n8n_data:/home/node/.n8n
      - ./workflows:/home/node/workflows
      - ./scripts:/home/node/scripts
      - ./data:/home/node/data

volumes:
  n8n_data:
```

Note: `WEBHOOK_URL` and `N8N_RUNNERS_ENABLED` are intentionally omitted. Telegram uses polling — no webhook URL is needed or safe to set.

- [ ] **Step 3: Validate compose file**

```bash
docker compose config
```

Expected: full resolved YAML printed, no errors.

- [ ] **Step 4: Deploy n8n**

```bash
docker compose up -d
```

Expected: `Container battersoft-n8n-n8n-1  Started`

- [ ] **Step 5: Verify n8n is running and secured**

```bash
# Check container running
docker ps | grep n8n
```
Expected: n8n container listed with status `Up`.

```bash
# Check health endpoint
curl -s http://localhost:5678/healthz
```
Expected: `{"status":"ok"}`

```bash
# Check basic auth is active (should return 401)
curl -s -o /dev/null -w "%{http_code}" http://localhost:5678/
```
Expected: `401`

- [ ] **Step 6: Create Telegram bot**

Open Telegram, find @BotFather, send `/newbot`. Follow prompts. Copy the bot token.
Set `TELEGRAM_BOT_TOKEN` in `.env`. Restart n8n to pick up the new env var:
```bash
docker compose restart n8n
```

- [ ] **Step 7: Get your Telegram chat ID**

Send any message to your new bot in Telegram, then:
```bash
source .env && curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"
```
Expected: JSON response containing `"chat":{"id":<NUMBER>}`. Copy that number.
Set `ALLOWED_CHAT_ID` in `.env`.

- [ ] **Step 8: Commit docker-compose**

```bash
git add docker-compose.yml
git commit -m "feat: add docker-compose.yml for n8n with localhost-only binding"
```

---

## Chunk 3: SQLite Schema + db.js

### Task 4: Database schema and init script

**Files:**
- Create: `scripts/db/schema.sql`
- Create: `scripts/db/init.js`

- [ ] **Step 1: Create directory**

```bash
mkdir -p scripts/db data
```

- [ ] **Step 2: Create `scripts/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS module_status (
  module             TEXT PRIMARY KEY,
  last_run           INTEGER,
  last_success       INTEGER,
  last_error         TEXT,
  run_count          INTEGER NOT NULL DEFAULT 0,
  error_count        INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  alert_sent_at      INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  module  TEXT NOT NULL,
  action  TEXT NOT NULL,
  detail  TEXT,
  success INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS error_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  module  TEXT NOT NULL,
  message TEXT NOT NULL,
  stack   TEXT
);

CREATE TABLE IF NOT EXISTS preferences (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  module        TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL
);

-- data column extends spec's definition: stores JSON {callbackModule, callbackAction, callbackParams}
-- needed by callback-handler.js to execute the confirmed action
CREATE TABLE IF NOT EXISTS pending_confirmations (
  action_id   TEXT PRIMARY KEY,
  module      TEXT NOT NULL,
  description TEXT NOT NULL,
  data        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_mapping (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  caldav_name   TEXT NOT NULL,
  caldav_id     TEXT NOT NULL UNIQUE,
  display_label TEXT NOT NULL,
  emoji         TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  owner_label   TEXT
);
```

- [ ] **Step 3: Create `scripts/db/init.js`**

```js
// scripts/db/init.js
// Run once to initialize the SQLite database: node scripts/db/init.js
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.DB_PATH

if (!dbPath) {
  console.error('DB_PATH environment variable is not set.')
  process.exit(1)
}

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
db.exec(schema)
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name).join(', ')
db.close()

console.log(`Database initialized at ${dbPath}`)
console.log('Tables:', tables)
```

- [ ] **Step 4: Run init script to verify schema**

```bash
source .env && node scripts/db/init.js
```

Expected output (path will match your `DB_PATH`):
```
Database initialized at /home/<your-user>/life-automation/data/agent.db
Tables: audit_log, calendar_mapping, error_log, module_status, pending_confirmations, preferences, token_log
```
(7 tables, alphabetically sorted)

- [ ] **Step 5: Commit**

```bash
git add scripts/db/
git commit -m "feat: SQLite schema and init script"
```

---

### Task 5: core/db.js

**Files:**
- Create: `scripts/core/db.js`
- Create: `tests/core/db.test.js`

- [ ] **Step 1: Create test directory**

```bash
mkdir -p scripts/core tests/core
```

- [ ] **Step 2: Write failing tests first**

Create `tests/core/db.test.js`:

```js
// tests/core/db.test.js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Use in-memory DB for all tests
process.env.DB_PATH = ':memory:'

const { getDb, auditLog, getPreference, setPreference, query, queryOne, run, checkBatchSize } = await import('../../scripts/core/db.js')

// Clean all tables before each test to prevent cross-test contamination
beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM audit_log; DELETE FROM preferences; DELETE FROM module_status; DELETE FROM error_log; DELETE FROM token_log; DELETE FROM pending_confirmations')
})

describe('db.js', () => {
  describe('auditLog', () => {
    it('inserts a row into audit_log', () => {
      auditLog('test-module', 'test-action', { id: 1 })
      const rows = query('SELECT * FROM audit_log WHERE module = ?', ['test-module'])
      assert.equal(rows.length, 1)
      assert.equal(rows[0].action, 'test-action')
      assert.equal(rows[0].success, 1)
    })

    it('stores metadata as JSON string', () => {
      auditLog('test-module', 'action2', { key: 'value' })
      const row = queryOne('SELECT detail FROM audit_log WHERE action = ?', ['action2'])
      assert.equal(JSON.parse(row.detail).key, 'value')
    })
  })

  describe('preferences', () => {
    it('sets and gets a preference', () => {
      setPreference('test-key', 'test-value')
      assert.equal(getPreference('test-key'), 'test-value')
    })

    it('returns null for missing key', () => {
      assert.equal(getPreference('nonexistent'), null)
    })

    it('overwrites existing preference', () => {
      setPreference('overwrite-key', 'first')
      setPreference('overwrite-key', 'second')
      assert.equal(getPreference('overwrite-key'), 'second')
    })
  })

  describe('checkBatchSize', () => {
    // Note: boolean return value is an extension beyond the spec (spec only defines throws).
    // true = secondary Telegram confirmation required before proceeding.
    it('returns false for items under or equal to 20', () => {
      assert.equal(checkBatchSize(new Array(10)), false)
      assert.equal(checkBatchSize(new Array(20)), false)
    })

    it('returns true for items over 20 (needs secondary confirm)', () => {
      const result = checkBatchSize(new Array(21))
      assert.equal(result, true)
    })

    it('throws for items over 50', () => {
      assert.throws(
        () => checkBatchSize(new Array(51)),
        /exceeds cap of 50/
      )
    })

    it('throws for non-array input', () => {
      assert.throws(
        () => checkBatchSize('not-an-array'),
        /must be an array/
      )
    })

    it('respects custom cap', () => {
      assert.throws(
        () => checkBatchSize(new Array(11), 10),
        /exceeds cap of 10/
      )
    })
  })
})
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
node --test tests/core/db.test.js
```

Expected: errors about missing module `../../scripts/core/db.js`.

- [ ] **Step 4: Create `scripts/core/db.js`**

```js
// scripts/core/db.js
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _db = null

export function getDb() {
  if (_db) return _db
  const dbPath = process.env.DB_PATH || ':memory:'
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  const schema = readFileSync(join(__dirname, '../db/schema.sql'), 'utf8')
  _db.exec(schema)
  return _db
}

export function auditLog(module, action, metadata = {}) {
  getDb().prepare(
    'INSERT INTO audit_log (ts, module, action, detail, success) VALUES (?, ?, ?, ?, 1)'
  ).run(Date.now(), module, action, JSON.stringify(metadata))
}

export function getPreference(key) {
  const row = getDb().prepare('SELECT value FROM preferences WHERE key = ?').get(key)
  return row ? row.value : null
}

export function setPreference(key, value) {
  getDb().prepare(
    'INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value))
}

export function query(sql, params = []) {
  return getDb().prepare(sql).all(params)
}

export function queryOne(sql, params = []) {
  return getDb().prepare(sql).get(params)
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(params)
}

export function checkBatchSize(items, cap = 50) {
  if (!Array.isArray(items)) throw new Error('checkBatchSize: items must be an array')
  if (items.length > cap) throw new Error(`Batch size ${items.length} exceeds cap of ${cap}`)
  return items.length > 20
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
node --test tests/core/db.test.js
```

Expected: all tests pass, output shows `✔` for each test case.

- [ ] **Step 6: Commit**

```bash
git add scripts/core/db.js scripts/db/schema.sql scripts/db/init.js tests/core/db.test.js
git commit -m "feat: core/db.js with SQLite wrapper and tests"
```

---

## Chunk 4: Logger + Telegram

### Task 6: core/logger.js

**Files:**
- Create: `scripts/core/logger.js`

Logger writes to stdout only (Docker captures logs). No DB writes.

**Deliberate scope reduction vs spec:** The spec mentions a SQLite `log` table, but `db.auditLog()` already captures all meaningful module actions. Adding a second SQLite write path from `logger` would duplicate storage and create circular dependency risk (logger ↔ db). Deferred indefinitely — if structured DB log querying is needed later, add it then.

- [ ] **Step 1: Create `scripts/core/logger.js`**

```js
// scripts/core/logger.js

function log(level, module, action, detail = '') {
  const ts = new Date().toISOString()
  const parts = [`[${ts}]`, `[${level.toUpperCase()}]`, `[${module}]`, action]
  if (detail) parts.push(`— ${detail}`)
  console.log(parts.join(' '))
}

export const logger = {
  info:  (module, action, detail) => log('info',  module, action, detail),
  warn:  (module, action, detail) => log('warn',  module, action, detail),
  error: (module, action, detail) => log('error', module, action, detail),
}
```

- [ ] **Step 2: Smoke-test logger**

```bash
node --input-type=module -e "
import { logger } from './scripts/core/logger.js'
logger.info('test', 'startup', 'logger works')
logger.warn('test', 'check', 'this is a warning')
logger.error('test', 'oops', 'something failed')
"
```

Expected: three timestamped lines printed to stdout.

- [ ] **Step 3: Commit**

```bash
git add scripts/core/logger.js
git commit -m "feat: core/logger.js — structured stdout logging"
```

---

### Task 7: core/telegram.js

**Files:**
- Create: `scripts/core/telegram.js`
- Create: `tests/core/telegram.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/core/telegram.test.js`:

```js
// tests/core/telegram.test.js
// Tests mock the Telegram HTTP API — no real network calls made.
import { describe, it, mock, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_CHAT_ID = '12345'

// Capture all fetch calls
const fetchCalls = []
global.fetch = async (url, options) => {
  fetchCalls.push({ url, body: JSON.parse(options?.body || '{}') })
  return {
    ok: true,
    json: async () => ({ ok: true, result: { message_id: 1 } }),
  }
}

const { send, sendWithButtons, sendDigest, reply, requestConfirmation } = await import('../../scripts/core/telegram.js')

afterEach(() => { fetchCalls.length = 0 })

describe('telegram.js', () => {
  describe('send', () => {
    it('calls sendMessage with correct chat_id and text', async () => {
      await send('hello world')
      assert.equal(fetchCalls.length, 1)
      assert.match(fetchCalls[0].url, /sendMessage/)
      assert.equal(fetchCalls[0].body.chat_id, '12345')
      assert.equal(fetchCalls[0].body.text, 'hello world')
    })
  })

  describe('sendWithButtons', () => {
    it('includes reply_markup with inline_keyboard', async () => {
      const buttons = [[{ text: 'Yes', callback_data: 'yes' }]]
      await sendWithButtons('Choose:', buttons)
      const body = fetchCalls[0].body
      assert.deepEqual(body.reply_markup.inline_keyboard, buttons)
    })
  })

  describe('sendDigest', () => {
    it('formats sections into a single message', async () => {
      await sendDigest([
        { header: '📧 Email', items: ['1. Item one', '2. Item two'] },
        { header: '📅 Calendar', items: ['Meeting 3pm'] },
      ])
      const text = fetchCalls[0].body.text
      assert.match(text, /📧 Email/)
      assert.match(text, /Item one/)
      assert.match(text, /📅 Calendar/)
    })
  })

  describe('reply', () => {
    it('sends with reply_to_message_id', async () => {
      await reply(42, 'thanks')
      assert.equal(fetchCalls[0].body.reply_to_message_id, 42)
    })
  })

  describe('requestConfirmation', () => {
    it('stores row in pending_confirmations and sends buttons', async () => {
      const { queryOne } = await import('../../scripts/core/db.js')
      await requestConfirmation({
        actionId: 'test_action_123',
        description: 'Delete 5 emails',
        callbackModule: 'gmail',
        callbackAction: 'deleteEmails',
        callbackParams: { ids: [1, 2, 3] },
      })
      // Check DB row was inserted
      const row = queryOne('SELECT * FROM pending_confirmations WHERE action_id = ?', ['test_action_123'])
      assert.ok(row)
      assert.equal(row.description, 'Delete 5 emails')
      const data = JSON.parse(row.data)
      assert.equal(data.callbackModule, 'gmail')
      assert.equal(data.callbackAction, 'deleteEmails')
      // Check Telegram message was sent with buttons
      const body = fetchCalls[0].body
      assert.match(body.text, /Delete 5 emails/)
      assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, 'confirm_test_action_123')
      assert.equal(body.reply_markup.inline_keyboard[0][1].callback_data, 'cancel_test_action_123')
    })
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/core/telegram.test.js
```

Expected: module not found error.

- [ ] **Step 3: Create `scripts/core/telegram.js`**

```js
// scripts/core/telegram.js
import { run as dbRun, queryOne } from './db.js'

const BASE = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`
const CHAT_ID = () => process.env.ALLOWED_CHAT_ID

async function call(method, body) {
  const res = await fetch(`${BASE()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Telegram ${method} failed ${res.status}: ${text}`)
  }
  return res.json()
}

export async function send(text) {
  return call('sendMessage', { chat_id: CHAT_ID(), text, parse_mode: 'HTML' })
}

export async function reply(messageId, text) {
  return call('sendMessage', {
    chat_id: CHAT_ID(),
    text,
    reply_to_message_id: messageId,
    parse_mode: 'HTML',
  })
}

export async function sendWithButtons(text, buttons) {
  return call('sendMessage', {
    chat_id: CHAT_ID(),
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  })
}

export async function sendDigest(sections) {
  const text = sections
    .map(s => `${s.header}\n${s.items.join('\n')}`)
    .join('\n\n')
  return send(text)
}

export async function answerCallbackQuery(callbackQueryId, text = '') {
  return call('answerCallbackQuery', { callback_query_id: callbackQueryId, text })
}

export async function requestConfirmation({ actionId, description, callbackModule, callbackAction, callbackParams = {} }) {
  const expiresAt = Math.floor(Date.now() / 1000) + 300
  dbRun(
    `INSERT INTO pending_confirmations (action_id, module, description, data, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(action_id) DO NOTHING`,
    [actionId, callbackModule, description, JSON.stringify({ callbackModule, callbackAction, callbackParams }), expiresAt]
  )
  await sendWithButtons(`⚠️ Confirm action:\n${description}`, [[
    { text: '✅ Confirm', callback_data: `confirm_${actionId}` },
    { text: '❌ Cancel',  callback_data: `cancel_${actionId}` },
  ]])
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node --test tests/core/telegram.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/core/telegram.js tests/core/telegram.test.js
git commit -m "feat: core/telegram.js with send, buttons, digest, confirm — with tests"
```

---

## Chunk 5: Status + Claude

### Task 8: core/status.js

**Files:**
- Create: `scripts/core/status.js`
- Create: `tests/core/status.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/core/status.test.js`:

```js
// tests/core/status.test.js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_CHAT_ID = '12345'

const sentMessages = []
global.fetch = async (url, opts) => {
  sentMessages.push(JSON.parse(opts?.body || '{}'))
  return { ok: true, json: async () => ({ ok: true }) }
}

const { heartbeat, error: statusError, report } = await import('../../scripts/core/status.js')
const { getDb, queryOne, query } = await import('../../scripts/core/db.js')

// Clean relevant tables before each test
beforeEach(() => {
  getDb().exec('DELETE FROM module_status; DELETE FROM error_log')
  sentMessages.length = 0
})

describe('status.js', () => {
  describe('heartbeat', () => {
    it('creates a module_status row on first call', async () => {
      await heartbeat('hb-mod')
      const row = queryOne('SELECT * FROM module_status WHERE module = ?', ['hb-mod'])
      assert.ok(row)
      assert.equal(row.run_count, 1)
      assert.equal(row.consecutive_errors, 0)
    })

    it('increments run_count on subsequent calls', async () => {
      await heartbeat('hb-mod')
      await heartbeat('hb-mod')
      await heartbeat('hb-mod')
      const row = queryOne('SELECT run_count FROM module_status WHERE module = ?', ['hb-mod'])
      assert.equal(row.run_count, 3)
    })

    it('resets consecutive_errors and alert_sent_at to 0/NULL after errors', async () => {
      await statusError('hb-mod', new Error('oops'))
      await statusError('hb-mod', new Error('oops2'))
      await heartbeat('hb-mod')
      const row = queryOne('SELECT consecutive_errors, alert_sent_at FROM module_status WHERE module = ?', ['hb-mod'])
      assert.equal(row.consecutive_errors, 0)
      assert.equal(row.alert_sent_at, null)
    })
  })

  describe('error', () => {
    it('increments error_count and consecutive_errors', async () => {
      await statusError('fail-mod', new Error('test error'))
      const row = queryOne('SELECT * FROM module_status WHERE module = ?', ['fail-mod'])
      assert.equal(row.error_count, 1)
      assert.equal(row.consecutive_errors, 1)
    })

    it('inserts into error_log', async () => {
      await statusError('log-mod', new Error('logged error'))
      const rows = query('SELECT * FROM error_log WHERE module = ?', ['log-mod'])
      assert.equal(rows.length, 1)
      assert.equal(rows[0].message, 'logged error')
    })

    it('sends Telegram alert after 3 consecutive failures', async () => {
      await statusError('alert-mod', new Error('fail 1'))
      await statusError('alert-mod', new Error('fail 2'))
      await statusError('alert-mod', new Error('fail 3'))
      assert.equal(sentMessages.length, 1)
      assert.match(sentMessages[0].text, /alert-mod/)
      assert.match(sentMessages[0].text, /3 times/)
    })

    it('does not send a second alert within 24h cooldown (self-contained)', async () => {
      // Set up 3 failures to trigger first alert
      await statusError('cooldown-mod', new Error('fail 1'))
      await statusError('cooldown-mod', new Error('fail 2'))
      await statusError('cooldown-mod', new Error('fail 3'))
      assert.equal(sentMessages.length, 1, 'first alert fired')
      // 4th failure should NOT send another alert (cooldown active)
      await statusError('cooldown-mod', new Error('fail 4'))
      assert.equal(sentMessages.length, 1, 'no second alert within cooldown')
    })
  })

  describe('report', () => {
    it('returns header string when no modules registered', async () => {
      const text = await report()
      assert.match(text, /System Status/)
      assert.match(text, /No modules registered/)
    })

    it('shows ⬜ for a module with run_count 0 (pre-seeded row)', async () => {
      getDb().prepare("INSERT INTO module_status (module, run_count, error_count, consecutive_errors) VALUES ('unrun-mod', 0, 0, 0)").run()
      const text = await report()
      assert.match(text, /⬜.*unrun-mod/)
    })

    it('shows ✅ for a module with no errors', async () => {
      await heartbeat('clean-mod')
      const text = await report()
      assert.match(text, /✅.*clean-mod/)
    })

    it('shows ❌ for a module whose last run failed', async () => {
      await statusError('broken-mod', new Error('something broke'))
      const text = await report()
      assert.match(text, /❌.*broken-mod/)
    })

    it('shows ⚠️ for a module with past errors but last run succeeded', async () => {
      await statusError('warn-mod', new Error('old error'))
      await heartbeat('warn-mod') // last run succeeded
      const text = await report()
      assert.match(text, /⚠️.*warn-mod/)
    })
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/core/status.test.js
```

Expected: module not found error.

- [ ] **Step 3: Create `scripts/core/status.js`**

```js
// scripts/core/status.js
import { getDb, query, queryOne } from './db.js'
import { send } from './telegram.js'

export async function heartbeat(moduleName) {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(`
    INSERT INTO module_status (module, last_run, last_success, run_count, error_count, consecutive_errors, alert_sent_at)
    VALUES (?, ?, ?, 1, 0, 0, NULL)
    ON CONFLICT(module) DO UPDATE SET
      last_run = excluded.last_run,
      last_success = excluded.last_success,
      run_count = run_count + 1,
      consecutive_errors = 0,
      alert_sent_at = NULL
  `).run(moduleName, now, now)
}

export async function error(moduleName, err) {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO error_log (ts, module, message, stack) VALUES (?, ?, ?, ?)'
  ).run(now, moduleName, err.message, err.stack ?? null)

  getDb().prepare(`
    INSERT INTO module_status (module, last_run, last_error, run_count, error_count, consecutive_errors)
    VALUES (?, ?, ?, 1, 1, 1)
    ON CONFLICT(module) DO UPDATE SET
      last_run = excluded.last_run,
      last_error = excluded.last_error,
      run_count = run_count + 1,
      error_count = error_count + 1,
      consecutive_errors = consecutive_errors + 1
  `).run(moduleName, now, err.message)

  const row = queryOne(
    'SELECT consecutive_errors, alert_sent_at FROM module_status WHERE module = ?',
    [moduleName]
  )
  if (row.consecutive_errors >= 3) {
    const withinCooldown = row.alert_sent_at && (now - row.alert_sent_at) < 86400
    if (!withinCooldown) {
      await send(`⚠️ ${moduleName} has failed 3 times in a row.\nLast error: ${err.message}\nRun 'status' for details.`)
      getDb().prepare(
        'UPDATE module_status SET alert_sent_at = ? WHERE module = ?'
      ).run(now, moduleName)
    }
  }
}

export async function report() {
  const rows = query('SELECT * FROM module_status ORDER BY module')
  const now = Math.floor(Date.now() / 1000)

  const lines = rows.map(row => {
    let icon, detail
    if (row.run_count === 0) {
      icon = '⬜'; detail = 'never run'
    } else if (row.consecutive_errors > 0) {
      icon = '❌'; detail = `FAILED ${age(now - row.last_run)} ago — ${(row.last_error ?? '').slice(0, 40)}`
    } else if (row.error_count > 0) {
      icon = '⚠️'; detail = `last run ${age(now - row.last_run)} ago · ${row.run_count} runs · ${row.error_count} errors`
    } else {
      icon = '✅'; detail = `last run ${age(now - row.last_run)} ago · ${row.run_count} runs · 0 errors`
    }
    return `${icon} ${row.module.padEnd(12)} ${detail}`
  })

  const date = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
  const header = `🤖 System Status — ${date}`
  return lines.length ? `${header}\n\n${lines.join('\n')}` : `${header}\n\nNo modules registered yet.`
}

function age(seconds) {
  if (seconds < 60)   return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node --test tests/core/status.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/core/status.js tests/core/status.test.js
git commit -m "feat: core/status.js — module health registry with proactive alerting"
```

---

### Task 9: core/claude.js

**Files:**
- Create: `scripts/core/claude.js`
- Create: `tests/core/claude.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/core/claude.test.js`:

```js
// tests/core/claude.test.js
// Mocks the Anthropic SDK — no real API calls made.
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ANTHROPIC_API_KEY = 'test-key'

// Mock Anthropic SDK before importing claude.js
const mockCreate = async ({ model, messages }) => ({
  content: [{ text: `mocked response for ${model}` }],
  usage: { input_tokens: 10, output_tokens: 5 },
})

// Patch the SDK using module mock
mock.module('@anthropic-ai/sdk', {
  namedExports: {},
  defaultExport: class MockAnthropic {
    constructor() { this.messages = { create: mockCreate } }
  },
})

const { ask } = await import('../../scripts/core/claude.js')
const { query } = await import('../../scripts/core/db.js')

describe('claude.js', () => {
  it('returns text from the model response', async () => {
    const result = await ask('Hello', 'haiku', { module: 'test' })
    assert.match(result, /mocked response/)
  })

  it('uses haiku model by default', async () => {
    const result = await ask('test')
    assert.match(result, /claude-haiku-4-5-20251001/)
  })

  it('uses sonnet model when specified', async () => {
    const result = await ask('test', 'sonnet')
    assert.match(result, /claude-sonnet-4-6/)
  })

  it('throws on unknown model name', async () => {
    await assert.rejects(
      () => ask('test', 'gpt-4'),
      /Unknown model/
    )
  })

  it('logs token usage to token_log table', async () => {
    await ask('Hello', 'haiku', { module: 'test-log' })
    const rows = query('SELECT * FROM token_log WHERE module = ?', ['test-log'])
    assert.ok(rows.length > 0)
    assert.equal(rows[0].input_tokens, 10)
    assert.equal(rows[0].output_tokens, 5)
  })

  it('does not log prompt content', async () => {
    const sensitivePrompt = 'SECRET_PHRASE_DO_NOT_LOG'
    await ask(sensitivePrompt, 'haiku', { module: 'privacy-test' })
    const rows = query("SELECT * FROM token_log WHERE module = 'privacy-test'")
    for (const row of rows) {
      assert.ok(!JSON.stringify(row).includes('SECRET_PHRASE_DO_NOT_LOG'))
    }
  })

  it('deletes token_log rows older than 30 days on each call', async () => {
    const { run: dbRun } = await import('../../scripts/core/db.js')
    // Insert a row with ts 31 days ago
    const old = Math.floor(Date.now() / 1000) - 31 * 86400
    dbRun('INSERT INTO token_log (ts, module, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
      [old, 'old-module', 'claude-haiku-4-5-20251001', 5, 5])
    // Confirm it exists
    assert.equal(query('SELECT * FROM token_log WHERE module = ?', ['old-module']).length, 1)
    // Trigger cleanup via ask()
    await ask('hello', 'haiku', { module: 'cleanup-trigger' })
    // Old row should be gone
    assert.equal(query('SELECT * FROM token_log WHERE module = ?', ['old-module']).length, 0)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/core/claude.test.js
```

Expected: module not found error.

- [ ] **Step 3: Create `scripts/core/claude.js`**

```js
// scripts/core/claude.js
import Anthropic from '@anthropic-ai/sdk'
import { run as dbRun } from './db.js'

const MODEL_IDS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
}

export async function ask(prompt, model = 'haiku', { module = 'unknown' } = {}) {
  const modelId = MODEL_IDS[model]
  if (!modelId) throw new Error(`Unknown model: '${model}'. Use 'haiku' or 'sonnet'.`)

  // Rolling 30-day retention cleanup
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400
  try { dbRun('DELETE FROM token_log WHERE ts < ?', [cutoff]) } catch { /* ignore */ }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const message = await client.messages.create({
    model: modelId,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  })

  try {
    dbRun(
      'INSERT INTO token_log (ts, module, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
      [Math.floor(Date.now() / 1000), module, modelId, message.usage.input_tokens, message.usage.output_tokens]
    )
  } catch { /* don't fail the request if logging fails */ }

  return message.content[0].text
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node --test tests/core/claude.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Run all core tests together**

```bash
node --test tests/core/*.test.js
```

Expected: all tests pass with no failures.

- [ ] **Step 6: Commit**

```bash
git add scripts/core/claude.js tests/core/claude.test.js
git commit -m "feat: core/claude.js — Claude API wrapper with token logging"
```

---

## Chunk 6: n8n Workflows

All workflows are built in the n8n UI at `http://localhost:5678` (log in with `admin` / `N8N_BASIC_AUTH_PASSWORD`). After building each workflow, export it as JSON and commit.

**How to export a workflow:** Open workflow → three-dot menu (⋮) → Download → saves as JSON. Move to the appropriate `workflows/` path.

### Task 10: Status module scaffold

Before building n8n workflows, create the status module entry point so n8n has something to call.

**Files:**
- Create: `scripts/modules/status/index.js`

- [ ] **Step 1: Create `scripts/modules/status/index.js`**

```js
// scripts/modules/status/index.js
import { report } from '../../core/status.js'
import { send } from '../../core/telegram.js'
import { heartbeat, error as statusError } from '../../core/status.js'

export async function run(input) {
  try {
    const text = await report()
    await send(text)
    await heartbeat('status')
  } catch (err) {
    await statusError('status', err)
    throw err
  }
}
```

- [ ] **Step 2: Create directory first, then move file into it**

```bash
mkdir -p scripts/modules/status
# If you created the file before the directory existed, move it:
# mv scripts/modules/status.js scripts/modules/status/index.js
```

- [ ] **Step 3: Commit**

```bash
git add scripts/modules/status/index.js
git commit -m "feat: status module entry point"
```

---

### Task 11: _router workflow (n8n UI)

Build in n8n UI. **Do this interactively** — n8n workflow JSON cannot be hand-authored reliably.

- [ ] **Step 1: Open n8n UI at `http://localhost:5678`**

Log in with `admin` / your `N8N_BASIC_AUTH_PASSWORD`.

- [ ] **Step 2: Create workflow named `_router`**

Add these nodes in order:

**Node 1 — Telegram Trigger**
- Type: Telegram Trigger
- Mode: **Polling** (not webhook)
- Credential: your Telegram bot token credential (create one in n8n Settings > Credentials)
- Update types: `message`

**Node 2 — IF: Validate chat_id**
- Type: IF
- Condition: `{{ $json.message.chat.id.toString() === $env.ALLOWED_CHAT_ID }}`
- True output → next node; False output → NoOp (terminate silently)

**Node 3 — Set: Normalize text**
- Type: Set
- Fields: `text` = `{{ $json.message.text.toLowerCase().trim() }}`

**Node 4 — Switch: Route by prefix**
- Type: Switch
- Mode: Rules
- Rules (in order):
  1. Value: `{{ $json.text }}`, Operation: starts with, Value: `$` → output "tiller"
  2. Value: `{{ $json.text }}`, Operation: starts with, Value: `cal` → output "calendar"
  3. Value: `{{ $json.text }}`, Operation: starts with, Value: `gh` → output "github"
  4. Value: `{{ $json.text }}`, Operation: starts with, Value: `news` → output "news"
  5. Value: `{{ $json.text }}`, Operation: equals, Value: `status` → output "status"
  6. Default output → "gmail"

**Node 5 — Execute Workflow: status**
- Type: Execute Workflow
- Workflow: (will set after creating status workflow in Task 12)
- Connect from Switch output "status"

For all other Switch outputs (tiller, calendar, gh, news, gmail): connect to a NoOp node for now (stub — will be wired up in Phase 1+).

**Do NOT activate the workflow yet** — the Execute Workflow node for "status" has no target workflow yet. Activation happens in Task 12 Step 2 after the status workflow is created.

- [ ] **Step 3: Export and commit (inactive)**

Export workflow as JSON. Save to `workflows/_router.json`.

```bash
mkdir -p workflows
git add workflows/_router.json
git commit -m "feat: n8n _router workflow — Telegram polling with command routing (not yet activated)"
```

---

### Task 12: Status workflow (n8n UI)

- [ ] **Step 1: Create directory for workflow exports**

```bash
mkdir -p workflows/modules
```

- [ ] **Step 2: Create workflow named `module/status`**

Use the **Code node** (not Execute Command — Code node runs within n8n's Node.js context and has access to the mounted `/home/node/scripts` volume):

**Node 1 — Code node**
```js
await import('/home/node/scripts/modules/status/index.js')
  .then(m => m.run({}))
return [{ json: { ok: true } }]
```

**Error handling:** In workflow Settings > Error Workflow, create or select an error notification workflow that sends a Telegram message: `Status workflow error: {{ $json.message }}`

- [ ] **Step 3: Wire the _router to this workflow**

Go back to `_router` workflow. Edit the Execute Workflow node for "status" output to point to this `module/status` workflow. Then **activate the `_router` workflow**.

- [ ] **Step 4: End-to-end test**

Send `status` to your Telegram bot.

Expected: message arrives within ~30 seconds:
```
🤖 System Status — [current date/time]

No modules registered yet.
```
(Or shows `status` module with recent run time if heartbeat was called.)

- [ ] **Step 5: Export and commit**

```bash
# Export from n8n UI: open workflow → ⋮ menu → Download → move to workflows/modules/status.json
git add workflows/modules/status.json workflows/_router.json
git commit -m "feat: n8n status workflow and activated router"
```

---

### Task 13: Callback handler workflow (n8n UI)

Handles `[Confirm]` and `[Cancel]` button presses from `requestConfirmation()`.

- [ ] **Step 1: Create `scripts/system/callback-handler.js`**

```js
// scripts/system/callback-handler.js
// Called by n8n when a Telegram callback_query arrives (button press)
import { run as dbRun, queryOne } from '../core/db.js'
import { answerCallbackQuery, send } from '../core/telegram.js'
import { logger } from '../core/logger.js'

export async function handle(callbackQuery) {
  const { id: callbackQueryId, data } = callbackQuery

  if (!data?.startsWith('confirm_') && !data?.startsWith('cancel_')) {
    // Not our callback — ignore
    return
  }

  const isConfirm = data.startsWith('confirm_')
  const actionId = data.replace(/^(confirm|cancel)_/, '')

  const row = queryOne('SELECT * FROM pending_confirmations WHERE action_id = ?', [actionId])
  if (!row) {
    await answerCallbackQuery(callbackQueryId, 'Action expired or already handled.')
    return
  }

  // Delete the pending confirmation row
  dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [actionId])

  if (!isConfirm) {
    await answerCallbackQuery(callbackQueryId, 'Cancelled.')
    await send('Action cancelled.')
    return
  }

  // Execute the stored callback
  const { callbackModule, callbackAction, callbackParams } = JSON.parse(row.data)
  await answerCallbackQuery(callbackQueryId, 'Confirmed! Processing...')

  try {
    const mod = await import(`../modules/${callbackModule}/index.js`)
    if (typeof mod[callbackAction] === 'function') {
      await mod[callbackAction](callbackParams)
    } else if (typeof mod.run === 'function') {
      await mod.run({ confirmedAction: callbackAction, confirmedParams: callbackParams })
    } else {
      throw new Error(`Module ${callbackModule} has no function '${callbackAction}' or 'run'`)
    }
    logger.info('callback-handler', 'executed', `${callbackModule}.${callbackAction}`)
  } catch (err) {
    logger.error('callback-handler', 'execution-failed', err.message)
    await send(`❌ Error executing confirmed action: ${err.message}`)
  }
}
```

- [ ] **Step 2: Create directory and verify file**

```bash
mkdir -p scripts/system workflows/system
# Verify the file was created correctly:
node --input-type=module -e "import('./scripts/system/callback-handler.js').then(() => console.log('OK'))"
```
Expected: `OK`

- [ ] **Step 3: Create callback-handler workflow in n8n UI**

**Node 1 — Telegram Trigger**
- Mode: Polling
- Update types: `callback_query`
- Same Telegram credential as `_router`

**Node 2 — Execute Code**
```js
const callbackQuery = $input.item.json.callback_query
await import('/home/node/scripts/system/callback-handler.js')
  .then(m => m.handle(callbackQuery))
return [{ json: { handled: true } }]
```

**Error node:** Telegram send `Callback handler error: {{ $json.message }}`

- [ ] **Step 4: Activate workflow**

- [ ] **Step 5: Test it**

Insert a test confirmation directly into SQLite, then tap the button from Telegram:

```bash
source .env
# Insert a test pending confirmation (expires 5 min from now)
EXPIRES=$(($(date +%s) + 300))
sqlite3 $DB_PATH "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES ('test_123', 'test', 'Test action', '{\"callbackModule\":\"status\",\"callbackAction\":\"run\",\"callbackParams\":{}}', $EXPIRES)"
```

Then send a message via the Telegram Bot API to your chat with the confirm button:
```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="${ALLOWED_CHAT_ID}" \
  -d text="Test confirmation" \
  -d reply_markup='{"inline_keyboard":[[{"text":"Confirm","callback_data":"confirm_test_123"},{"text":"Cancel","callback_data":"cancel_test_123"}]]}'
```

Tap **Confirm** in Telegram. Expected:
1. n8n callback-handler execution log shows success with `handled: true`
2. "Confirmed! Processing..." appears as button response
3. Row deleted from `pending_confirmations`: `sqlite3 $DB_PATH "SELECT COUNT(*) FROM pending_confirmations WHERE action_id='test_123'"` → `0`

- [ ] **Step 6: Export and commit**

```bash
git add scripts/system/callback-handler.js
# Export from n8n, save to workflows/system/callback-handler.json
git add workflows/system/callback-handler.json
git commit -m "feat: callback handler for Telegram confirm/cancel buttons"
```

---

### Task 14: Confirmation timeout workflow (n8n UI)

Cleans up expired `pending_confirmations` rows every 60 seconds and notifies the user.

- [ ] **Step 1: Create `scripts/system/confirm-timeout.js`**

```js
// scripts/system/confirm-timeout.js
import { query, run as dbRun } from '../core/db.js'
import { send } from '../core/telegram.js'

export async function cleanExpired() {
  const now = Math.floor(Date.now() / 1000)
  const expired = query(
    'SELECT * FROM pending_confirmations WHERE expires_at < ?',
    [now]
  )
  if (expired.length === 0) return

  for (const row of expired) {
    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [row.action_id])
    await send(`⏱ Action timed out (no response within 5 minutes):\n${row.description}`)
  }
}
```

- [ ] **Step 2: Create timeout workflow in n8n UI**

**Node 1 — Schedule Trigger**
- Interval: every 60 seconds

**Node 2 — Execute Code**
```js
await import('/home/node/scripts/system/confirm-timeout.js')
  .then(m => m.cleanExpired())
return [{ json: { ran: true } }]
```

**Node 3 — Error branch (add via "Add Error Output" on Node 2)**

Connect an Execute Code node to Node 2's error output:
```js
// Node 3 — error handler
const err = $input.first().json.error
await import('/home/node/scripts/core/telegram.js')
  .then(m => m.send(`⚠️ confirm-timeout workflow error: ${err.message ?? err}`))
return [{ json: { error: true } }]
```

- [ ] **Step 3: Test the timeout workflow manually**

Insert a row that is already expired, then wait for the next trigger cycle (up to 60 seconds):

```bash
# Insert an expired pending_confirmation (expires_at in the past)
sqlite3 ~/life-automation/data/agent.db \
  "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) \
   VALUES ('timeout_test', 'test', 'Test timeout action', '{}', $(date +%s -d '10 minutes ago' 2>/dev/null || date -v-10M +%s))"
```

Expected within 60 seconds:
- Telegram message arrives: `⏱ Action timed out (no response within 5 minutes):\nTest timeout action`
- Row is deleted: `sqlite3 ~/life-automation/data/agent.db "SELECT * FROM pending_confirmations WHERE action_id='timeout_test'"` returns empty

- [ ] **Step 4: Activate workflow**

- [ ] **Step 5: Export and commit**

```bash
git add scripts/system/confirm-timeout.js
# Export from n8n, save to workflows/system/confirm-timeout.json
git add workflows/system/confirm-timeout.json
git commit -m "feat: confirmation timeout cleanup workflow"
```

---

## Chunk 7: Smoke Test + Phase Outlines

### Task 15: End-to-end smoke test

- [ ] **Step 1: Run all tests**

```bash
node --test tests/core/*.test.js
```

Expected: all tests pass, zero failures.

- [ ] **Step 2: Verify n8n is running**

```bash
docker ps | grep n8n
curl -s http://localhost:5678/healthz
```

Expected: container running, `{"status":"ok"}`.

- [ ] **Step 3: Send `status` from Telegram**

Send the word `status` to your bot.

Expected within 30 seconds:
```
🤖 System Status — [date/time]

✅ status       last run Xs ago · 1 runs · 0 errors
```
(The status module's own heartbeat shows up.)

- [ ] **Step 4: Verify security — basic auth**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5678/
```

Expected: `401`

- [ ] **Step 5: Verify security — localhost only**

Confirm n8n is bound to `127.0.0.1` only, not `0.0.0.0`:

```bash
ss -tlnp | grep 5678
```

Expected output contains `127.0.0.1:5678`, **not** `0.0.0.0:5678`. If you see `0.0.0.0`, stop — check `docker-compose.yml` ports section and ensure it reads `"127.0.0.1:${N8N_PORT:-5678}:5678"`.

```bash
# This should succeed (localhost)
curl -s http://localhost:5678/healthz
```

Expected: `{"status":"ok"}`

- [ ] **Step 6: Final commit — update CHANGELOG**

In `CHANGELOG.md`, move all Phase 0 items from `[Unreleased]` into a new versioned entry:

```markdown
## [v0.1.0] — YYYY-MM-DD

### Added
- Docker/n8n deployment with localhost-only binding and basic auth
- Core library: db, logger, telegram, status, claude
- Telegram bot router (n8n workflow)
- Status command with per-module health icons
- Confirmation request lifecycle (requestConfirmation + callback handler)
- Confirmation timeout cleanup workflow
```

Then commit:

```bash
git add CHANGELOG.md
git commit -m "chore: Phase 0 complete — infrastructure, core library, Telegram router"
```

---

## Phase 1–5 Outlines

These are high-level outlines only. Each phase gets its own detailed plan when it's time to implement.

---

### Phase 1: Gmail Agent

**Separate plan file:** `docs/superpowers/plans/YYYY-MM-DD-phase-1-gmail.md`

Key deliverables:
- `scripts/modules/gmail/index.js` — polling, classification, archiving
- `scripts/modules/gmail/prompts.js` — classification prompt (haiku), digest format prompt
- `workflows/modules/gmail.json` — scheduled every 15–30 min + daily digest at configurable time
- Daily digest with sections: Needs Attention, LinkedIn Messages, FYI, Auto-archived counts
- LinkedIn reply flow: detect linkedin.com sender → draft reply → Telegram [Send]/[Edit]/[Skip]
- Daily 5 PM deletion prompt: build candidate list → `sendWithButtons` → [Delete All]/[Review List]/[Skip]
- n8n OAuth credential: Gmail with `gmail.modify` + `gmail.send` scopes
- Dry-run mode: `DRY_RUN=true` env var logs actions without executing

---

### Phase 2: Calendar Agent

**Separate plan file:** `docs/superpowers/plans/YYYY-MM-DD-phase-2-calendar.md`

Key deliverables:
- `scripts/modules/calendar/index.js` — parse input, read/write CalDAV, conflict detection
- `scripts/modules/calendar/prompts.js` — NL event parsing prompt (returns JSON: title, date, startTime, durationMins, location, calendarLabel, rrule)
- `workflows/modules/calendar.json` — triggered by `cal` prefix
- `cal` command router integration
- Initial calendar mapping setup (`Set up my calendars` flow → populate `calendar_mapping` table)
- Today view, week ahead view, morning briefing sub-workflow (callable by other workflows)
- n8n credential: `n8n-nodes-caldav-calendar` community node with Header Auth

---

### Phase 3: Tiller Budget Assistant

**Separate plan file:** `docs/superpowers/plans/YYYY-MM-DD-phase-3-tiller.md`

Key deliverables:
- `scripts/modules/tiller/index.js` — `$` prefix command handler, Q&A against Sheets data
- `scripts/modules/tiller/prompts.js` — Sheets Q&A prompt (sonnet), weekly summary prompt
- `workflows/modules/tiller.json` — triggered by `$` prefix + Sunday 7 PM schedule
- Google Sheets API: read-only, map Tiller sheet structure once in preferences
- Weekly spending summary: category totals vs budget, delivered Sunday evenings
- Budget alert rule creation: `$Alert me when X exceeds Y` → stores in `preferences` → n8n polls daily

---

### Phase 4: News Briefing

**Separate plan file:** `docs/superpowers/plans/YYYY-MM-DD-phase-4-news.md`

Key deliverables:
- `scripts/modules/news/index.js` — RSS aggregation, Claude curation, 7:30 AM delivery
- `scripts/modules/news/prompts.js` — curation prompt (haiku) with feedback history context
- `workflows/modules/news.json` — 7:30 AM schedule trigger
- Sources: Hacker News API, dev.to API, GitHub trending RSS, podcast RSS feeds, NWS weather API
- Feedback loop: `more 1` / `less 1` / `save 1` Telegram commands → stored in `preferences` table, fed back into next curation prompt
- Morning briefing integrates calendar today-view by calling calendar sub-workflow

---

### Phase 5: GitHub Agent

**Separate plan file:** `docs/superpowers/plans/YYYY-MM-DD-phase-5-github.md`

Key deliverables:
- `.github/workflows/claude.yml` — Claude Code agent (issues assigned to `@claude`)
- `.github/workflows/claude-review.yml` — read-only PR reviewer
- `scripts/modules/github/index.js` — Telegram `gh` command → create GitHub issue via API
- `workflows/modules/github.json` — `gh` prefix trigger
- GitHub Secrets: `ANTHROPIC_API_KEY`
- Branch protection: require 1 human approval before merge

---

*Plan authored 2026-03-14 — implements spec `docs/superpowers/specs/2026-03-14-n8n-automation-suite-design.md`*
