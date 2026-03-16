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

## Deferred Issues — Required Practice
If a code review or implementation uncovers any issue (Important OR Minor) that will not be fixed immediately:
- Add it to the **"Carry-Forward Issues"** section of the active plan file immediately
- Tag Important issues with which task should fix them (e.g., "To address in Task 13")
- Tag Minor issues with severity "Minor" — these are reviewed collectively at the end of all tasks to decide yes/no on addressing each one
- Never leave a known issue only in conversation context — it will be lost

## Branching and PRs
- **Never push directly to `main` for new phases or features** — Phase 0 was an exception
- Create a branch per phase or feature: `git checkout -b phase-1-gmail`
- Open a PR when the work is ready for review — the owner must approve before merge
- Commits within a branch are fine to push incrementally; only `main` is protected

## Before Opening a PR
- Export updated n8n workflows to workflows/ directory
- Add entry to CHANGELOG.md
- Document any new env vars in .env.example
- Confirm no secrets in code or logs

## Security Rules
- **Never read `.env`** — it contains secrets. Reference `.env.example` for variable names and documentation
- Google OAuth tokens: never log, never expose in error messages
- Telegram: ALLOWED_CHAT_ID validated on every inbound message
- CalDAV: app-specific password only, never Apple ID password
- Sheets API: read-only scope — reject any write attempt
- Telegram polling only — never configure webhook mode
