# AGENTS.md — Building a New Module

## Architecture

**Bot service** (`scripts/system/telegram-router-main.js`) handles all Telegram I/O:
- Long-polls getUpdates and routes commands to modules
- Handles callback_query (confirm/cancel buttons)
- Runs confirm-timeout cleanup every 60s

**n8n** handles scheduled triggers only (daily digest, weekly summary, etc.).
n8n Code nodes cannot use `import()` — scheduled n8n workflows must call a
local HTTP endpoint on the bot service, not run scripts directly.

## What a module is
A module = one Node.js directory (`scripts/modules/<name>/`).
Telegram command modules need no n8n workflow — the bot service routes to them directly.
Scheduled modules need an n8n Schedule Trigger workflow that calls the bot's HTTP endpoint.

## Step-by-step checklist

1. Create `scripts/modules/<name>/index.js`:
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

2. Create `scripts/modules/<name>/prompts.js` with all Claude prompt strings.
   Do not put prompt strings in index.js.

3. **If the module responds to a Telegram command:** add a route in
   `scripts/system/telegram-router.js` `handleUpdate()` following the existing
   pattern (text match → dynamic import → run).

4. **If the module runs on a schedule:** add an n8n Schedule Trigger workflow
   that calls `http://bot:3000/<name>` (the bot service HTTP endpoint).
   Export as `workflows/modules/<name>.json`.

5. Add new env vars to `.env.example` (with `export`, comment above each var).

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
- **Do not read `.env`** — it contains secrets. Reference `.env.example` for variable names and documentation
- Do not write to the Tiller Google Sheet (read-only)
- Do not open inbound ports or configure Telegram webhooks
- Do not push directly to main — create a branch (`git checkout -b phase-N-name`) and open a PR for owner approval
