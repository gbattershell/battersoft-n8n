# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com) — Added / Changed / Fixed / Removed.

## [Unreleased]

### Changed
- `auditLog(module, action, metadata, success)` now accepts an optional `success` param (default `1`) — callers can pass `0` to record a failed action
- `getDb()` skips schema DDL if tables already exist, avoiding redundant work on warm file databases
- `closeDb()` exported from `core/db.js` — resets singleton for test isolation or graceful shutdown
- Error detail in status report `❌` lines increased from 40 to 80 chars with word-boundary truncation
- `callbackModule` in callback-handler validated against `/^[a-z0-9-]+$/` before dynamic import
- `confirm-timeout.js` send failures now caught and logged via `logger.error` instead of propagating silently

### Fixed
- `answerCallbackQuery` now covered by tests — previously untested, a regression would cause spinning Telegram buttons
- `requestConfirmation` `expires_at` field now asserted in tests — 5-minute timeout was previously unverified
- `send()` and `reply()` JSDoc now explicitly documents HTML parse_mode escaping requirement for callers

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
     - Status report now shows last-run time in local timezone instead of UTC
     - Router Switch node now checks `gh` prefix before `gmail` to avoid false matches -->

### Fixed
<!-- Bug fixes. Describe what was broken, what the symptom was, and what the fix was.
     Examples:
     - Status report showed ⚠️ for modules that had never errored (off-by-one in error_count check)
     - Confirmation timeout cleanup now correctly handles multiple expired rows in one cycle
     - `send()` now HTML-escapes `&`, `<`, `>` in user strings to prevent Telegram parse errors -->

### Removed
<!-- Removed features, deleted files, dropped support, deprecated APIs.
     If something was replaced by something else, name both.
     Examples:
     - Removed `scripts/core/legacy-router.js` (replaced by n8n Switch node routing)
     - Dropped WEBHOOK_URL env var — polling-only per security spec, webhooks not supported -->

## [v0.1.0] — 2026-03-14

### Added
- Docker Compose setup with localhost-only n8n binding (`127.0.0.1:5678`) and basic auth
- SQLite schema: 7 tables covering audit log, module status, error log, preferences, token usage, pending confirmations, and calendar mapping
- `core/db.js` — SQLite wrapper with `auditLog`, `getPreference`/`setPreference`, `checkBatchSize`, and generic `query`/`queryOne`/`run` helpers
- `core/logger.js` — structured stdout logging with ISO timestamp, level, module, and action fields
- `core/telegram.js` — `send`, `reply`, `sendWithButtons`, `sendDigest`, `answerCallbackQuery`, `requestConfirmation`
- `core/status.js` — per-module heartbeat/error tracking; sends Telegram alert after 3 consecutive failures with 24h cooldown
- `core/claude.js` — Claude API wrapper supporting `haiku` and `sonnet` aliases; 30-day rolling token usage log
- Telegram bot router workflow: polling mode, chat ID allowlist validation, command routing via Switch node
- `status` Telegram command: per-module health icons (✅ healthy · ⚠️ past errors · ❌ currently failing · ⬜ never run)
- Confirmation lifecycle: `requestConfirmation()` stores pending row → user taps inline button → callback handler dispatches to module
- Confirmation timeout: expired pending_confirmations purged every 60s with user notification
- `CLAUDE.md` — coding standards, core library API reference, security rules, and deferred-issue tracking policy for AI agents
- `AGENTS.md` — step-by-step guide for building new modules with core library reference and destructive-action rules
