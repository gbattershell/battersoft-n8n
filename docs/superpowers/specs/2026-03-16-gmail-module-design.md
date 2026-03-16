# Gmail Module — Design Spec
**Date:** 2026-03-16
**Status:** Draft
**Phase:** 1

---

## 1. Overview

The Gmail module surfaces actionable emails in a daily digest and automates deletion suggestions for low-value emails at 5 PM. It runs as part of the existing bot service and is triggered both on a schedule (via n8n) and on demand via Telegram command.

**In scope:**
- Daily digest of actionable emails + recent orders
- On-demand `gmail` Telegram command (triggers digest immediately)
- 5 PM deletion suggestion batch with confirm/skip

**Out of scope:**
- LinkedIn reply drafting
- Auto-archiving
- Gmail send (scope reserved for a future phase — not requested in OAuth consent at this time)

---

## 2. Architecture

```
gmail command ──────────────────────────────────────────────────────┐
                                                                     │
7:30 AM n8n trigger → POST http://bot:3000/gmail/digest             │
         │                                                           ▼
         └──────────────────────────────► scripts/modules/gmail/index.js
                                                   │
                                    ┌──────────────┼──────────────┐
                                    ▼              ▼              ▼
                             gmail-client.js  classifier.js  core/telegram.js
                                    │              │
                             db.getSecret()   prompts.js
                          (AES-256-GCM token)

5 PM n8n trigger → POST http://bot:3000/gmail/deletion
         │
         ▼
scripts/modules/gmail/index.js   ← deletion batch path
```

### New files

| File | Purpose |
|------|---------|
| `scripts/modules/gmail/index.js` | Entry point — routes between digest and deletion actions |
| `scripts/modules/gmail/gmail-client.js` | Gmail API wrapper — fetch, token refresh |
| `scripts/modules/gmail/classifier.js` | Rule-based filter + Claude haiku fallback |
| `scripts/modules/gmail/prompts.js` | All Claude prompt strings |
| `scripts/modules/gmail/setup.js` | One-time CLI OAuth flow — run inside the bot container (see Section 3) |
| `scripts/system/http-server.js` | Reusable HTTP server for n8n scheduled trigger calls (used by all future scheduled modules) |
| `workflows/modules/gmail-digest.json` | n8n Schedule Trigger → POST `http://bot:3000/gmail/digest` |
| `workflows/modules/gmail-deletion.json` | n8n Schedule Trigger → POST `http://bot:3000/gmail/deletion` |

`workflows/modules/` is established here as the convention for all future module workflow files.

### Modified files

| File | Change |
|------|--------|
| `scripts/core/db.js` | Add `setSecret(key, value)` / `getSecret(key)` — AES-256-GCM encrypted storage |
| `scripts/system/telegram-router-main.js` | Import and start http-server alongside polling loop (see Section 4) |
| `scripts/system/telegram-router.js` | Wire default fallback to gmail digest — any Telegram message that doesn't match a known command prefix triggers the digest (same as typing `gmail`) |
| `scripts/db/init.js` | Add `data TEXT` column to `pending_confirmations` via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` |
| `docker-compose.yml` | Add `ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` to bot service environment block |
| `.env.example` | Add `ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; remove stale comment about n8n managing Google OAuth |

---

## 3. Gmail Authentication

Uses the `googleapis` npm package. Tokens are stored encrypted in SQLite — no plain text secrets at rest.

### Token storage

Two new methods on `core/db.js`:

```js
db.setSecret(key, value)   // encrypts with AES-256-GCM, stores in preferences table
db.getSecret(key)          // decrypts and returns value, or null if not set
```

Encryption key: `ENCRYPTION_KEY` env var (32-byte hex string). The ciphertext stored in the preferences table is a JSON string `{ iv, tag, data }` — all base64-encoded — making it clearly distinguishable from plain preference values. Running `setSecret` twice on the same key overwrites the previous value.

### Initial setup

`scripts/modules/gmail/setup.js` — **run once inside the bot container** after first deploy:

```bash
docker compose exec bot node scripts/modules/gmail/setup.js
```

Steps:
1. Prints OAuth consent URL to terminal
2. User visits URL, authorizes, pastes back the code
3. Script exchanges code for tokens, encrypts and stores `gmail_refresh_token` via `db.setSecret()`

Running on the host directly will target a different `DB_PATH` than the container — always run via `docker compose exec`.

OAuth scopes requested (principle of least privilege — `gmail.send` is NOT included until a send feature is built):
- `https://www.googleapis.com/auth/gmail.modify` — read, label, trash

### Token refresh

`gmail-client.js` holds a `google.auth.OAuth2` instance. On each API call:
- If access token is expired, `googleapis` auto-refreshes using the stored refresh token
- On refresh, if a new refresh token is returned it is re-encrypted and saved via `db.setSecret()`
- If refresh fails (revoked, expired): throws with a clear message → caught in `index.js` → Telegram alert: "⚠️ Gmail auth failed — run `docker compose exec bot node scripts/modules/gmail/setup.js` to re-authorize"

---

## 4. HTTP Server

`scripts/system/http-server.js` — a minimal HTTP server using Node.js built-in `http` module (no Express dependency). Used by all scheduled modules.

```js
// Usage in any module — called at import time
import { registerRoute } from '../../system/http-server.js'
registerRoute('POST', '/gmail/digest', handler)
registerRoute('POST', '/gmail/deletion', handler)

// Started once in telegram-router-main.js
import { startHttpServer } from './http-server.js'
startHttpServer(3000)   // called before start() — non-blocking, does not delay polling
```

- Listens on port 3000 inside the Docker compose network — addressed by n8n as `http://bot:3000/...`
- Port 3000 is NOT mapped to the host in `docker-compose.yml` (internal only)
- `startHttpServer()` is called before `start()` in `telegram-router-main.js` and is non-blocking — a startup error in the HTTP server is fatal (process exits)
- Returns 404 for unknown routes, 500 with JSON error body on handler exceptions
- No auth — internal Docker network only, not reachable from outside the compose network

---

## 5. Classification Logic

### Pass 1 — Rule-based (no Claude)

Rules are evaluated in order. **First matching rule wins** — no email is evaluated by more than one rule.

| Priority | Signal | Classification |
|----------|--------|---------------|
| 1 (highest) | Has attachment | actionable |
| 2 | Thread has > 1 message (reply chain) | actionable |
| 3 | Gmail label `CATEGORY_PROMOTIONS` or `CATEGORY_SOCIAL` | deletable |
| 4 | Has `List-Unsubscribe` header + single-message thread | deletable |
| — | No rule matched | → Pass 2 (Claude) |

Attachment presence takes priority over all labels. A promotional email with an attachment (PDF receipt, event ticket) is treated as actionable.

### Pass 2 — Claude haiku (ambiguous only)

Emails that don't match any rule are sent to Claude haiku in a single batched call. Claude receives sender, subject, and snippet (no full body) and returns a JSON array with one entry per email:

```json
[{ "id": "msg-id", "label": "actionable" | "deletable" | "order", "reason": "..." }]
```

All ambiguous emails are sent in a single batched call with `max_tokens: 2048`. At 50 emails × ~20 tokens per JSON entry, peak output is ~1000 tokens — comfortably within the limit. The response format is strict JSON to avoid parsing ambiguity.

### Order age logic (applied after classification)

| Age | Treatment |
|-----|-----------|
| < 24 hours | Include in digest under "📦 Orders" |
| 24 hours – 90 days | Silent keep — omitted from digest and deletion batch |
| ≥ 90 days | Deletable — included in 5 PM deletion batch |

### Starred emails

Starred emails are never included in the deletion batch regardless of classification.

### Batch size

Before calling the Gmail API, `db.checkBatchSize(emails, 50)` is called. The caller slices the email list to 50 before calling `checkBatchSize` — the function is used as a safety assertion, not a truncation mechanism.

---

## 6. Telegram Interface

### Daily digest (7:30 AM + `gmail` command)

```
📧 Gmail Digest — Mon Mar 16, 7:30 AM

🔴 Actionable (3)
• John Smith — "Project proposal review" (2h ago)
• DMV — "License renewal required" (1d ago)
• LinkedIn — "Sarah sent you a message" (3h ago)

📦 Orders (2)
• Amazon — "Your order has shipped" (1h ago)
• UPS — "Out for delivery" (3h ago)

✅ Nothing else needs your attention
```

- If inbox is clean: single message "✅ Inbox clear"
- Digest is read-only — no inline buttons
- All sender names and subjects are HTML-escaped before passing to `telegram.send()` (parse_mode is HTML)
- `db.auditLog('gmail', 'digest', { actionable, orders, deletable_count })` called after each digest

### 5 PM deletion batch

```
🗑 Deletion suggestions — 8 emails

1. Gap — "20% off this weekend" (Mar 1)
2. LinkedIn — "Someone viewed your profile" (Feb 28)
3. Amazon — "Order from 94 days ago" (Dec 13)
...

[Delete All] [Review] [Skip Today]
```

This is **not** implemented via `requestConfirmation()` — that helper only supports two-button confirm/cancel flows. The deletion batch uses `telegram.sendWithButtons()` directly with three custom callback buttons.

**Callback data shape:**

| Button | `callback_data` |
|--------|----------------|
| Delete All | `gmail_delete_all_<batchId>` |
| Review | `gmail_review_<batchId>` |
| Skip Today | `gmail_skip_<batchId>` |

`batchId` is a timestamp string (e.g. `1741234567890`). The list of message IDs for the batch is stored in the `pending_confirmations` table in a new `data` TEXT column added via `ALTER TABLE` in `scripts/db/init.js` (using `IF NOT EXISTS` check so existing installs are safe). `action_id` = batchId, `description` = human-readable summary, `data` = JSON-serialised array of message ID strings. 50 Gmail message IDs fit well within a TEXT column (no size limit in SQLite).

**[Delete All]** flow:
1. Callback handler reads message IDs from `pending_confirmations` by batchId
2. `db.auditLog('gmail', 'delete_batch_start', { count, ids })` called before trashing
3. Moves all to Trash via Gmail API batch operation
4. `db.auditLog('gmail', 'delete_batch_complete', { succeeded, failed })` called after
5. Telegram confirmation: "🗑 Trashed 8 emails" (or partial failure report)
6. Deletes row from `pending_confirmations`

**[Review]** flow:
1. Callback handler reads message IDs from `pending_confirmations`
2. Sends each email one at a time with [Trash] / [Keep] buttons
   - Callback data: `gmail_trash_<msgId>` / `gmail_keep_<msgId>`
3. Each [Trash] call logs to `audit_log` and moves one email to Trash
4. [Keep] logs to `audit_log` and takes no other action
5. Row deleted from `pending_confirmations` after last item is resolved

**[Skip Today]** — deletes row from `pending_confirmations`, no action taken.

Auto-dismissed after 5 minutes: `pending_confirmations` cleanup (running in bot service setInterval) sends "🗑 Deletion prompt expired — skipped for today" and deletes the row.

---

## 7. Error Handling

| Scenario | Behaviour |
|----------|-----------|
| OAuth token refresh fails | Telegram alert with `docker compose exec bot node scripts/modules/gmail/setup.js` instructions |
| Claude classification fails | Fall back to rule-based labels only for that batch; digest still sends; `logger.warn()` |
| Gmail API quota / network error | `status.error()` called; Telegram alert fires after 3 consecutive failures (standard `status.js` behaviour) |
| Batch delete partial failure | Report succeeded and failed counts; `db.auditLog` with both counts; do not silently swallow |
| Empty inbox / no actionable emails | Send "✅ Inbox clear" — never send an empty digest |
| `setup.js` run on host instead of in container | Out of scope for runtime error handling — documented in setup instructions only |

---

## 8. Testing

| File | What is tested |
|------|---------------|
| `tests/modules/gmail/classifier.test.js` | All rule branches in priority order; attachment beats CATEGORY_PROMOTIONS; order age cutoffs (< 24h, 24h–90d, ≥ 90d); starred email exclusion; Claude mocked |
| `tests/core/db.test.js` | `setSecret`/`getSecret` round-trip; verify stored value is not plain text; overwrite behaviour |
| `tests/modules/gmail/gmail-client.test.js` | Token refresh path; new refresh token saved on rotation; googleapis mocked |
| `tests/modules/gmail/index.test.js` | Digest flow end-to-end (actionable + orders + clean inbox); deletion batch flow (delete all, review, skip); HTML escaping of subjects/senders; all external calls mocked |

No live Gmail API calls in tests. `setup.js` is a manual one-time script with no automated test.

---

## 9. New Environment Variables

| Variable | Description |
|----------|-------------|
| `ENCRYPTION_KEY` | 32-byte hex string for AES-256-GCM secret encryption. Generate: `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret from Google Cloud Console |

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` must also be added to the `bot` service `environment:` block in `docker-compose.yml`.

Google OAuth refresh token is stored encrypted in SQLite — not in `.env`.

---

*Built with Claude AI — design approved 2026-03-16*
