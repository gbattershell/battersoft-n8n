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
- Do not push directly to main — create a branch (`git checkout -b phase-N-name`) and open a PR for owner approval
