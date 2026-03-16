# Gmail Module — Design Spec
**Date:** 2026-03-16
**Status:** Approved
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

---

## 2. Architecture

```
gmail command / 7:30 AM n8n trigger
         │
         ▼
scripts/modules/gmail/index.js
         │
         ├── gmail-client.js     ← Gmail API wrapper (googleapis npm package)
         │        │
         │        └── db.getSecret('gmail_refresh_token')  ← AES-256-GCM encrypted
         │
         ├── classifier.js       ← rule-based filter first, Claude haiku for ambiguous
         │        │
         │        └── prompts.js
         │
         └── core/telegram.js    ← send digest or deletion batch

5 PM n8n trigger
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
| `scripts/modules/gmail/setup.js` | One-time CLI OAuth flow — run manually to store refresh token |
| `scripts/system/http-server.js` | Reusable HTTP server for n8n scheduled trigger calls (used by all future scheduled modules) |
| `workflows/modules/gmail-digest.json` | n8n Schedule Trigger → POST /gmail/digest |
| `workflows/modules/gmail-deletion.json` | n8n Schedule Trigger → POST /gmail/deletion |

### Modified files

| File | Change |
|------|--------|
| `scripts/core/db.js` | Add `setSecret(key, value)` / `getSecret(key)` — AES-256-GCM encrypted storage |
| `scripts/system/telegram-router-main.js` | Import and start http-server alongside polling loop |
| `scripts/system/telegram-router.js` | Wire default fallback to gmail digest |
| `scripts/db/init.js` | No schema changes needed — existing tables sufficient |
| `.env.example` | Add `ENCRYPTION_KEY` |

---

## 3. Gmail Authentication

Uses the `googleapis` npm package. Tokens are stored encrypted in SQLite — no plain text secrets at rest.

### Token storage

Two new methods on `core/db.js`:

```js
db.setSecret(key, value)   // encrypts with AES-256-GCM, stores in preferences table
db.getSecret(key)          // decrypts and returns value, or null if not set
```

Encryption key: `ENCRYPTION_KEY` env var (32-byte hex string). Added to `.env.example`.

The `preferences` table is reused — encrypted values are stored alongside regular preferences. The ciphertext is a JSON string containing `{ iv, tag, data }` — all base64-encoded.

### Initial setup

`scripts/modules/gmail/setup.js` — run once manually:
1. Opens OAuth consent URL in terminal output
2. User visits URL, authorizes, pastes back the code
3. Script exchanges code for tokens, encrypts and stores `gmail_refresh_token` via `db.setSecret()`

OAuth scopes required:
- `https://www.googleapis.com/auth/gmail.modify` — read, label, trash
- `https://www.googleapis.com/auth/gmail.send` — reserved for future use

### Token refresh

`gmail-client.js` holds a `google.auth.OAuth2` instance. On each API call:
- If access token is expired, `googleapis` auto-refreshes using the stored refresh token
- On refresh, the new refresh token (if rotated) is re-encrypted and saved via `db.setSecret()`
- If refresh fails (revoked, expired): throws with a clear message → caught in `index.js` → Telegram alert

---

## 4. HTTP Server

`scripts/system/http-server.js` — a minimal Express-free HTTP server (Node.js built-in `http` module) used by all scheduled modules.

```js
// Usage in any module
import { registerRoute } from '../../system/http-server.js'
registerRoute('POST', '/gmail/digest', handler)
registerRoute('POST', '/gmail/deletion', handler)

// Started once in telegram-router-main.js
import { startHttpServer } from './http-server.js'
startHttpServer(3000)
```

- Listens on port 3000 (internal Docker network only — not exposed in docker-compose.yml)
- Routes registered by each module at import time
- Returns 404 for unknown routes, 500 with JSON error body on handler exceptions
- No auth — internal Docker network only, not reachable from outside the compose network

---

## 5. Classification Logic

### Pass 1 — Rule-based (no Claude)

**Definite deletable:**
- Gmail label `CATEGORY_PROMOTIONS` or `CATEGORY_SOCIAL`
- Has `List-Unsubscribe` header + no attachment + single-message thread (threadSize === 1)

**Definite actionable:**
- Has attachment
- Thread has more than 1 message (reply chain exists)

### Pass 2 — Claude haiku (ambiguous only)

Emails that don't match any rule above are sent to Claude haiku in a single batched call. Claude receives sender, subject, and snippet (no full body) for each ambiguous email and returns one of three labels per email:

- `actionable` — needs user attention
- `deletable` — no action needed, safe to trash
- `order` — order confirmation, shipping notification, or receipt

### Order age logic (applied after classification)

| Age | Treatment |
|-----|-----------|
| < 24 hours | Include in digest under "📦 Orders" |
| 24 hours – 90 days | Silent keep — omitted from digest and deletion batch |
| ≥ 90 days | Deletable — included in 5 PM deletion batch |

### Starred emails

Starred emails are never included in the deletion batch regardless of classification.

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
- Capped at 50 emails processed per run (`db.checkBatchSize`)

### 5 PM deletion batch

```
🗑 Deletion suggestions — 8 emails

1. Gap — "20% off this weekend" (Mar 1)
2. LinkedIn — "Someone viewed your profile" (Feb 28)
3. Amazon — "Order from 94 days ago" (Dec 13)
...

[Delete All] [Review] [Skip Today]
```

- **[Delete All]** — moves all listed emails to Trash in one batch; confirms count to user
- **[Review]** — sends each email individually with [Trash] / [Keep] buttons
- **[Skip Today]** — dismisses without action
- Auto-dismissed after 5 minutes with no response (standard `requestConfirmation` timeout)
- If no deletion candidates: no message sent
- Capped at 50 per batch (`db.checkBatchSize`)

---

## 7. Error Handling

| Scenario | Behaviour |
|----------|-----------|
| OAuth token refresh fails | Telegram alert: "⚠️ Gmail auth failed — run `node scripts/modules/gmail/setup.js` to re-authorize" |
| Claude classification fails | Fall back to rule-based labels only for that batch; digest still sends; logs warning |
| Gmail API quota / network error | `status.error()` called; Telegram alert fires after 3 consecutive failures (standard `status.js` behaviour) |
| Batch delete partial failure | Report succeeded and failed counts; do not silently swallow errors |
| Empty inbox / no actionable emails | Send "✅ Inbox clear" — never send an empty digest |

---

## 8. Testing

| File | What is tested |
|------|---------------|
| `tests/modules/gmail/classifier.test.js` | All rule branches (CATEGORY_PROMOTIONS, CATEGORY_SOCIAL, List-Unsubscribe, attachment, thread length); order age cutoffs (< 24h, 24h–90d, ≥ 90d); Claude mocked |
| `tests/core/db.test.js` | `setSecret`/`getSecret` round-trip; verify stored value is not plain text |
| `tests/modules/gmail/gmail-client.test.js` | Token refresh path; googleapis mocked |
| `tests/modules/gmail/index.test.js` | Digest and deletion flows end-to-end; all external calls mocked |

No live Gmail API calls in tests. `setup.js` is a manual one-time script with no automated test.

---

## 9. New Environment Variables

| Variable | Description |
|----------|-------------|
| `ENCRYPTION_KEY` | 32-byte hex string used for AES-256-GCM secret encryption. Generate: `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret from Google Cloud Console |

Google OAuth refresh token is stored encrypted in SQLite — not in `.env`.

---

*Built with Claude AI — design approved 2026-03-16*
