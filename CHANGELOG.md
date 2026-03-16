# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com) — Added / Changed / Fixed / Removed.

## [Unreleased]

### Added
<!-- New features, new modules, new workflows, new commands, new env vars.
     One bullet per meaningful change — not one bullet per phase or per file.
     Be specific enough that someone can understand what changed without reading the diff.
     Examples:
     - Gmail module with daily digest and Claude-powered email classification (haiku)
     - `cal next week` Telegram command showing 7-day calendar view with emoji per calendar
     - New env var: DIGEST_TIME (24h format, default "07:30") controls morning briefing delivery -->

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
