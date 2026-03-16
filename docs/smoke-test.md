# Phase 0 Smoke Test

End-to-end verification checklist. Run these steps in order after deploying for the first time.

---

## Prerequisites

- `.env` is filled in (TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID, DB_PATH, N8N_ENCRYPTION_KEY, N8N_BASIC_AUTH_PASSWORD)
- Telegram bot created via @BotFather and token set in `.env`
- ALLOWED_CHAT_ID set (see Step 1 below if not done yet)

---

## Step 1: Get your Telegram chat ID (if not set yet)

Send any message to your bot, then:

```bash
source .env
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | python3 -m json.tool | grep '"id"' | head -5
```

Copy the chat `id` value. Set `ALLOWED_CHAT_ID=<that number>` in `.env`.

---

## Step 2: Initialize the database

```bash
source .env && node scripts/db/init.js
```

Expected:
```
Database initialized at /home/<user>/life-automation/data/agent.db
Tables: audit_log, calendar_mapping, error_log, module_status, pending_confirmations, preferences, token_log
```

---

## Step 3: Build and start n8n

```bash
docker compose up --build -d
```

The `--build` flag is required on first start (builds the custom image with your npm deps). After that, `docker compose up -d` is sufficient unless `package.json` changes.

**Verify container is running:**
```bash
docker ps | grep n8n
```

**Verify health endpoint:**
```bash
curl -s http://localhost:5678/healthz
```
Expected: `{"status":"ok"}`

**Verify basic auth is active (should return 401):**
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5678/
```
Expected: `401`

---

## Step 4: Import workflows into n8n

1. Open n8n at `http://localhost:5678` — log in with `admin` / `N8N_BASIC_AUTH_PASSWORD`
2. Import each workflow (top-right menu → Import from File):
   - `workflows/modules/status.json` → import first (you'll need its ID for the router)
   - `workflows/system/callback-handler.json`
   - `workflows/system/confirm-timeout.json`
   - `workflows/_router.json` → import last

---

## Step 5: Create Telegram credential in n8n

1. Go to **Settings → Credentials → Add Credential**
2. Type: **Telegram API**
3. Name it: `Telegram Bot`
4. Token: paste your `TELEGRAM_BOT_TOKEN`
5. Save

---

## Step 6: Wire credentials to Telegram Trigger nodes

Open each workflow that has a Telegram Trigger and assign the credential:
- `_router` — Telegram Trigger → select "Telegram Bot"
- `system/callback-handler` — Telegram Trigger → select "Telegram Bot"

---

## Step 7: Wire the Execute Workflow node in _router

1. Open the `_router` workflow
2. Click the **"Execute: status"** node
3. In **Workflow** field, search for and select `module/status`
4. Save

---

## Step 8: Activate workflows

Activate in this order (toggle the slider in each workflow):
1. `module/status`
2. `system/callback-handler`
3. `system/confirm-timeout`
4. `_router` — **activate last**

---

## Step 9: End-to-end smoke test

Send the word `status` to your Telegram bot.

**Expected response** (within ~30 seconds):
```
🤖 System Status — [current date/time]

No modules registered yet.
```

If the status module has already run once, you'll see:
```
🤖 System Status — Mon Mar 16, 9:30 AM

✅ status       last run 0s ago · 1 runs · 0 errors
```

---

## Troubleshooting

**No response from bot:**
- Check n8n execution log: open `_router` workflow → Executions tab
- Verify Telegram credential is set on the Trigger node
- Verify ALLOWED_CHAT_ID matches your actual chat ID

**"Cannot find module 'better-sqlite3'" in Code node:**
- The Docker image wasn't built with the Dockerfile. Run `docker compose up --build -d`.

**"SyntaxError: Cannot use import statement" in Code node:**
- The `package.json` wasn't copied into the image. Rebuild: `docker compose up --build -d`.

**DB_PATH errors:**
- Verify `data/` directory exists: `mkdir -p data`
- Verify `DB_PATH` in `.env` is an absolute path inside WSL2 (e.g. `/home/garrett/life-automation/data/agent.db`)
- The `data/` directory is mounted at `/home/node/data` in the container. DB_PATH must match the container path: use `/home/node/data/agent.db` as DB_PATH, or adjust the volume mount.

> **Note on DB_PATH:** The container mounts `./data` at `/home/node/data`. Scripts running inside the container see the DB at `/home/node/data/agent.db`. Set `DB_PATH=/home/node/data/agent.db` in `.env` so both the host `init.js` script and the container Code nodes use the same SQLite file.

---

## Phase 0 complete ✅

Once the `status` command responds correctly, Phase 0 is done. All subsequent modules (Phase 1: Gmail, Phase 2: Calendar, etc.) build on this foundation.
