# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com) — Added / Changed / Fixed / Removed.

<!-- AGENTS: The commented examples below are permanent reference — do NOT remove them.
     They exist to guide future entries. Always add real entries above the example comments,
     never replace or delete the comments themselves. -->

## [Unreleased]

### Added
- Tiller module: read-only Google Sheets Q&A via `$` Telegram command — Claude haiku analyzes transactions and budget data; weekly spending digest (Sunday noon) with per-category budget status, emoji warnings (⚠️ <10% remaining, 🚨 over budget), and uncategorized transaction count
- `scripts/modules/tiller/sheets-client.js`: googleapis wrapper with separate OAuth2 consent (spreadsheets.readonly scope), dynamic header-row parsing
- `scripts/modules/tiller/setup.js`: one-time CLI for Google Sheets OAuth consent — stores refresh token AES-256-GCM encrypted in SQLite
- Calendar module: full CRUD for iCloud CalDAV via `cal` Telegram command — read (today/tomorrow/this week/next week/free-form), create with conflict detection (hard overlap blocks, soft 30min proximity advisory), edit via [Edit] button + natural language delta + [Undo], delete with confirmation; supports all 8 shared calendars with per-event calendar labels
- `scripts/modules/calendar/caldav-client.js`: tsdav + ical.js wrapper with DAVClient singleton, iCalendar parsing/serialization, timezone conversion
- `scripts/modules/calendar/parser.js`: Claude haiku NLP — natural language → structured event JSON
- `scripts/modules/calendar/setup.js`: one-time CLI for Apple ID email + app-specific password + timezone — stores credentials AES-256-GCM encrypted in SQLite
- Router edit-await intercept: `telegram-router.js` default fallback checks for pending `cal_edit_await_` rows before routing to Gmail, enabling free-text edit replies without `cal` prefix
<!-- New features or capabilities.
     Examples:
     - Gmail module: daily digest at 7:30 AM — surfaces actionable emails with Claude haiku fallback
     - `core/db.js`: `setSecret` / `getSecret` — AES-256-GCM encrypted storage via ENCRYPTION_KEY -->

### Changed
<!-- Changes to existing behavior, APIs, configuration, or defaults.
     Include what changed AND why — the why helps future agents understand intent.
     Examples:
     - `checkBatchSize` default cap raised from 50 to 100 (Gmail archives regularly exceed 50)
     - Status report now shows last-run time in local timezone instead of UTC -->

### Fixed
<!-- Bug fixes. Describe what was broken, what the symptom was, and what the fix was.
     Examples:
     - Status report showed ⚠️ for modules that had never errored (off-by-one in error_count check)
     - `send()` now HTML-escapes `&`, `<`, `>` in user strings to prevent Telegram parse errors -->

### Removed
<!-- Removed features, deleted files, dropped support, deprecated APIs.
     If something was replaced by something else, name both.
     Examples:
     - Removed `scripts/core/legacy-router.js` (replaced by n8n Switch node routing)
     - Dropped WEBHOOK_URL env var — polling-only per security spec, webhooks not supported -->

## [v0.2.0] — 2026-03-18

### Added
- Gmail module: daily digest at 7:30 AM and on-demand via any Telegram message — surfaces actionable emails and recent orders with Claude haiku classification fallback
- Gmail module: 5 PM deletion batch — identifies promotions, social notifications, and orders >90 days; presents batches of 10 with [Delete All] / [Review] / [Skip Batch] buttons; navigates pre-fetched batches without re-fetching from Gmail
- `core/db.js`: `setSecret(key, value)` / `getSecret(key)` — AES-256-GCM encrypted secret storage using `ENCRYPTION_KEY` env var
- `scripts/system/http-server.js`: reusable HTTP server for n8n scheduled triggers; modules call `registerRoute()` to register endpoints at import time; listens on port 3000 (Docker internal only)
- `scripts/modules/gmail/setup.js`: one-time OAuth CLI script to authorize Gmail and store refresh token encrypted in SQLite — run on host with `source .env && node scripts/modules/gmail/setup.js`
- n8n workflows `workflows/modules/gmail-digest.json` (7:30 AM) and `workflows/modules/gmail-deletion.json` (5 PM)
- New env vars: `ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

### Changed
- Default Telegram fallback (unrecognized message) now triggers Gmail digest instead of no-op

### Fixed
- `core/claude.js`: `maxTokens` option was ignored — hardcoded 1024 overrode caller's value; now passed through correctly
- Gmail classifier: recent orders (<24h) were routed to `actionable` instead of `orders` array

## [v0.1.0] — 2026-03-16

### Added
- Docker Compose setup: n8n bound to `127.0.0.1:5678` (n8n 2.x built-in user management — no basic auth env vars)
- Standalone Node.js bot service (`scripts/system/telegram-router-main.js` + `telegram-router.js`) running as a separate Docker service (`Dockerfile.bot`) — long-polls Telegram getUpdates, validates chat ID allowlist on every message, routes commands to modules, handles callback_query
- Confirmation timeout cleanup runs every 60s via `setInterval` in the bot service entry point — purges expired `pending_confirmations` rows and notifies user
- SQLite schema: 7 tables covering audit log, module status, error log, preferences, token usage, pending confirmations, and calendar mapping
- `core/db.js` — SQLite wrapper with `auditLog`, `getPreference`/`setPreference`, `checkBatchSize`, and generic `query`/`queryOne`/`run` helpers; `closeDb()` exported for test isolation and graceful shutdown; `auditLog` accepts optional `success` param (default `1`) for recording failed actions
- `core/logger.js` — structured stdout logging with ISO timestamp, level, module, and action fields
- `core/telegram.js` — `send`, `reply`, `sendWithButtons`, `sendDigest`, `answerCallbackQuery`, `requestConfirmation`; `callbackModule` validated against `/^[a-z0-9-]+$/` before dynamic import
- `core/status.js` — per-module heartbeat/error tracking; sends Telegram alert after 3 consecutive failures with 24h cooldown; error detail truncated at 80 chars with word-boundary
- `core/claude.js` — Claude API wrapper supporting `haiku` and `sonnet` aliases; 30-day rolling token usage log; throws on missing `ANTHROPIC_API_KEY` so features degrade gracefully when key is absent
- `status` Telegram command: per-module health icons (✅ healthy · ⚠️ past errors · ❌ currently failing · ⬜ never run)
- Confirmation lifecycle: `requestConfirmation()` stores pending row → user taps inline button → callback handler dispatches to module; send failures in timeout cleanup caught and logged rather than propagating
- `CLAUDE.md` — coding standards, core library API reference, security rules, and deferred-issue tracking policy for AI agents
- `AGENTS.md` — step-by-step guide for building new modules with core library reference and destructive-action rules
