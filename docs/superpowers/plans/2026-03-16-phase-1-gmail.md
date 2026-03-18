# Phase 1 — Gmail Module Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Gmail module — daily digest of actionable emails, on-demand `gmail` Telegram command, and 5 PM batch deletion prompt.

**Architecture:** A standalone Node.js bot service routes Telegram commands to `scripts/modules/gmail/index.js`. Scheduled runs are triggered by n8n POSTing to `http://bot:3000/gmail/digest` and `/gmail/deletion` via a new reusable HTTP server. Gmail API access uses the `googleapis` npm package with an AES-256-GCM encrypted refresh token stored in SQLite. Email classification uses rule-based pre-filtering with Claude haiku as a fallback for ambiguous messages.

**Tech Stack:** Node.js ES modules, `googleapis` npm package, Google OAuth 2.0 (`gmail.modify` scope), `node:crypto` AES-256-GCM, `node:http` server, Claude haiku (`claude-haiku-4-5-20251001`), better-sqlite3, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-03-16-gmail-module-design.md`

---

## File Map

**New files:**
- `scripts/modules/gmail/index.js` — entry point; `run(input)` for Telegram + HTTP, `handleCallback(callbackQuery)` for button presses
- `scripts/modules/gmail/gmail-client.js` — Gmail API wrapper (list, get, trash)
- `scripts/modules/gmail/classifier.js` — rule-based + Claude haiku classification
- `scripts/modules/gmail/prompts.js` — all Claude prompt strings
- `scripts/modules/gmail/setup.js` — one-time OAuth CLI script (run on host, not in container)
- `scripts/system/http-server.js` — reusable HTTP server for n8n triggers
- `tests/system/http-server.test.js`
- `tests/modules/gmail/classifier.test.js`
- `tests/modules/gmail/gmail-client.test.js`
- `tests/modules/gmail/index.test.js`
- `workflows/modules/gmail-digest.json`
- `workflows/modules/gmail-deletion.json`

**Modified files:**
- `scripts/core/db.js` — add `setSecret(key, value)` / `getSecret(key)`
- `scripts/modules/gmail/index.js` — add `registerRoute` calls for HTTP triggers
- `scripts/system/telegram-router-main.js` — import gmail module (triggers route registration), start http-server
- `scripts/system/telegram-router.js` — wire default fallback to gmail digest
- `scripts/system/callback-handler.js` — extend to dispatch `<module>_*` callbacks to module's `handleCallback`
- `tests/core/db.test.js` — add setSecret/getSecret tests
- `docker-compose.yml` — add `ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` to bot env
- `.env.example` — add same vars; remove stale n8n OAuth comment
- `package.json` + `package-lock.json` — add `googleapis` dependency

---

## Carry-Forward Issues

*(None at plan creation — add here as they are discovered during implementation)*

---

## Chunk 1: Branch + Core Extensions

### Task 1: Create branch

- [ ] **Create and checkout the feature branch**

```bash
git checkout -b phase-1-gmail
```

Expected: `Switched to a new branch 'phase-1-gmail'`

---

### Task 2: `db.setSecret` / `db.getSecret`

**Files:**
- Modify: `scripts/core/db.js`
- Modify: `tests/core/db.test.js`

The `preferences` table is reused. Ciphertext is stored as a JSON string `{"iv":"...","tag":"...","data":"..."}` (all base64). This is distinguishable from plain preference values. `ENCRYPTION_KEY` must be a 32-byte hex string (64 hex chars).

- [ ] **Step 1: Add the failing tests to `tests/core/db.test.js`**

At the top of the file after the existing `process.env.DB_PATH = ':memory:'` line, add:
```js
process.env.ENCRYPTION_KEY = 'a'.repeat(64) // 32 bytes as hex — test value only
```

Update the destructured import line to include the new exports:
```js
const { getDb, closeDb, auditLog, getPreference, setPreference, query, queryOne, run, checkBatchSize, setSecret, getSecret } = await import('../../scripts/core/db.js')
```

Add a new `describe` block inside the outer `describe('db.js', ...)`:

```js
describe('setSecret / getSecret', () => {
  it('round-trips a secret value', () => {
    setSecret('test-secret', 'my-value')
    assert.equal(getSecret('test-secret'), 'my-value')
  })

  it('stored value is not plain text', () => {
    setSecret('test-secret-2', 'plain-text-value')
    const raw = getPreference('test-secret-2')
    assert.ok(raw !== 'plain-text-value')
    assert.ok(raw.includes('"iv"')) // stored as JSON ciphertext
  })

  it('overwrites previous secret on second call', () => {
    setSecret('overwrite-secret', 'first')
    setSecret('overwrite-secret', 'second')
    assert.equal(getSecret('overwrite-secret'), 'second')
  })

  it('returns null for unknown key', () => {
    assert.equal(getSecret('nonexistent-secret'), null)
  })

  it('throws if ENCRYPTION_KEY is not set', () => {
    const saved = process.env.ENCRYPTION_KEY
    delete process.env.ENCRYPTION_KEY
    try {
      assert.throws(() => setSecret('x', 'y'), /ENCRYPTION_KEY/)
    } finally {
      process.env.ENCRYPTION_KEY = saved
    }
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
node --experimental-test-module-mocks --test tests/core/db.test.js
```

Expected: Fails with `setSecret is not a function` or similar.

- [ ] **Step 3: Implement `setSecret` and `getSecret` in `scripts/core/db.js`**

Add after the existing imports at the top of `db.js`:
```js
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const CIPHER_ALGO = 'aes-256-gcm'

function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY
  if (!key) throw new Error('ENCRYPTION_KEY is not set')
  return Buffer.from(key, 'hex')
}
```

Add at the bottom of `db.js`:
```js
export function setSecret(key, value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(CIPHER_ALGO, getEncryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const ciphertext = JSON.stringify({
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  })
  setPreference(key, ciphertext)
}

export function getSecret(key) {
  const raw = getPreference(key)
  if (!raw) return null
  try {
    const { iv, tag, data } = JSON.parse(raw)
    const decipher = createDecipheriv(CIPHER_ALGO, getEncryptionKey(), Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return decipher.update(Buffer.from(data, 'base64')) + decipher.final('utf8')
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
node --experimental-test-module-mocks --test tests/core/db.test.js
```

Expected: All tests pass including the new `setSecret / getSecret` block.

- [ ] **Step 5: Run full suite to check for regressions**

```bash
node --experimental-test-module-mocks --test tests/**/*.test.js
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/core/db.js tests/core/db.test.js
git commit -m "feat: add setSecret/getSecret AES-256-GCM encrypted storage to db.js"
```

---

### Task 3: `http-server.js`

**Files:**
- Create: `scripts/system/http-server.js`
- Create: `tests/system/http-server.test.js`

A lightweight Node.js `http` module wrapper. Routes are registered by modules before the server starts. Listens on port 3000 inside Docker (addressed by n8n as `http://bot:3000/...`). Not exposed to the host.

- [ ] **Step 1: Write the failing tests**

Create `tests/system/http-server.test.js`:

```js
// tests/system/http-server.test.js
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

let server, port

before(async () => {
  const mod = await import('../../scripts/system/http-server.js')

  mod.registerRoute('POST', '/test-route', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })

  mod.registerRoute('POST', '/test-error', async () => {
    throw new Error('handler exploded')
  })

  server = mod.startHttpServer(0) // port 0 = OS assigns random port
  await new Promise(resolve => server.once('listening', resolve))
  port = server.address().port
})

after(() => server.close())

async function post(path) {
  return fetch(`http://localhost:${port}${path}`, { method: 'POST' })
}

describe('http-server.js', () => {
  it('returns 200 for a registered route', async () => {
    const res = await post('/test-route')
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.ok, true)
  })

  it('returns 404 for unknown routes', async () => {
    const res = await post('/nonexistent')
    assert.equal(res.status, 404)
  })

  it('returns 500 when the handler throws', async () => {
    const res = await post('/test-error')
    assert.equal(res.status, 500)
    const json = await res.json()
    assert.ok(json.error.includes('exploded'))
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
node --experimental-test-module-mocks --test tests/system/http-server.test.js
```

Expected: Fails — file doesn't exist yet.

- [ ] **Step 3: Implement `scripts/system/http-server.js`**

```js
// scripts/system/http-server.js
// Reusable HTTP server for n8n scheduled trigger calls.
// Modules call registerRoute() at import time.
// startHttpServer() is called once in telegram-router-main.js before the polling loop.
import { createServer } from 'node:http'
import { logger } from '../core/logger.js'

const routes = new Map()

export function registerRoute(method, path, handler) {
  routes.set(`${method} ${path}`, handler)
}

export function startHttpServer(port) {
  const server = createServer(async (req, res) => {
    const key = `${req.method} ${req.url}`
    const handler = routes.get(key)
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }
    try {
      await handler(req, res)
    } catch (err) {
      logger.error('http-server', 'handler-error', err.message)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    }
  })

  server.on('error', (err) => {
    logger.error('http-server', 'startup-error', err.message)
    process.exit(1)
  })

  server.listen(port, () => {
    logger.info('http-server', 'started', `listening on port ${port}`)
  })

  return server
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
node --experimental-test-module-mocks --test tests/system/http-server.test.js
```

Expected: All 3 tests pass.

- [ ] **Step 5: Run full suite**

```bash
node --experimental-test-module-mocks --test tests/**/*.test.js
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/system/http-server.js tests/system/http-server.test.js
git commit -m "feat: add reusable http-server.js for n8n scheduled trigger calls"
```

---

### Task 4: Extend `callback-handler.js` for module-dispatched callbacks

**Files:**
- Modify: `scripts/system/callback-handler.js`
- Create: `tests/system/callback-handler.test.js`

Currently `callback-handler.js` only handles `confirm_` and `cancel_` prefixes. Gmail needs `gmail_*` callbacks. The extension: if the data prefix is not `confirm` or `cancel`, extract the module name from the first `_`-delimited segment and dispatch to that module's `handleCallback(callbackQuery)`. This pattern scales to all future modules.

- [ ] **Step 1: Write the failing tests**

Create `tests/system/callback-handler.test.js`:

```js
// tests/system/callback-handler.test.js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_CHAT_ID = '123'

const fetchMock = mock.fn(async () => ({ ok: true, json: async () => ({}) }))
global.fetch = fetchMock

const { handle } = await import('../../scripts/system/callback-handler.js')
const { getDb } = await import('../../scripts/core/db.js')

beforeEach(() => {
  getDb().prepare('DELETE FROM pending_confirmations').run()
  fetchMock.mock.resetCalls()
})

describe('callback-handler — module dispatch', () => {
  it('dispatches gmail_* callback data to gmail module handleCallback', async () => {
    let called = false
    mock.module('../../scripts/modules/gmail/index.js', () => ({
      handleCallback: async () => { called = true },
    }))

    await handle({ id: 'cq1', data: 'gmail_skip_1741234567890' })
    assert.ok(called)
  })

  it('answers with error if module has no handleCallback export', async () => {
    mock.module('../../scripts/modules/nohandler/index.js', () => ({}))

    await handle({ id: 'cq2', data: 'nohandler_action_123' })

    // fetch was called (answerCallbackQuery)
    assert.ok(fetchMock.mock.calls.length > 0)
  })

  it('ignores callback data with invalid module prefix (uppercase)', async () => {
    await handle({ id: 'cq3', data: 'INVALID_action' })
    // fetch called once for answerCallbackQuery
    assert.ok(fetchMock.mock.calls.length > 0)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
node --experimental-test-module-mocks --test tests/system/callback-handler.test.js
```

Expected: Fails — module dispatch logic doesn't exist yet.

- [ ] **Step 3: Extend `callback-handler.js`**

The existing `handle()` function starts with an early return if data doesn't start with `confirm_` or `cancel_`. Replace that guard and add the module dispatch path. The `confirm_`/`cancel_` logic block is unchanged — wrap it in an `if` branch and add the module dispatch as an `else`:

```js
export async function handle(callbackQuery) {
  const { id: callbackQueryId, data } = callbackQuery

  if (data?.startsWith('confirm_') || data?.startsWith('cancel_')) {
    const isConfirm = data.startsWith('confirm_')
    const actionId = data.replace(/^(confirm|cancel)_/, '')

    const row = queryOne('SELECT * FROM pending_confirmations WHERE action_id = ?', [actionId])
    if (!row) {
      await answerCallbackQuery(callbackQueryId, 'Action expired or already handled.')
      return
    }

    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [actionId])

    if (!isConfirm) {
      await answerCallbackQuery(callbackQueryId, 'Cancelled.')
      await send('Action cancelled.')
      return
    }

    const { callbackModule, callbackAction, callbackParams } = JSON.parse(row.data)
    await answerCallbackQuery(callbackQueryId, 'Confirmed! Processing...')

    try {
      if (!/^[a-z0-9-]+$/.test(callbackModule)) {
        throw new Error(`Invalid callbackModule identifier: '${callbackModule}'`)
      }
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
    return
  }

  // Module-dispatched callback: data format is '<module>_<action>_<params>'
  // Extract module name from first '_'-delimited segment.
  const modulePrefix = data?.split('_')[0]
  if (!modulePrefix || !/^[a-z0-9-]+$/.test(modulePrefix)) {
    await answerCallbackQuery(callbackQueryId, 'Unknown action.')
    return
  }

  try {
    const mod = await import(`../modules/${modulePrefix}/index.js`)
    if (typeof mod.handleCallback !== 'function') {
      throw new Error(`Module '${modulePrefix}' has no handleCallback export`)
    }
    await mod.handleCallback(callbackQuery)
  } catch (err) {
    logger.error('callback-handler', 'module-dispatch-failed', err.message)
    await answerCallbackQuery(callbackQueryId, 'Error handling action.')
    await send(`❌ Callback error: ${err.message}`)
  }
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
node --experimental-test-module-mocks --test tests/system/callback-handler.test.js
```

Expected: All tests pass.

- [ ] **Step 5: Run full suite**

```bash
node --experimental-test-module-mocks --test tests/**/*.test.js
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/system/callback-handler.js tests/system/callback-handler.test.js
git commit -m "feat: extend callback-handler to dispatch module-prefixed callbacks to module handleCallback"
```

---

## Chunk 2: Gmail Infrastructure

### Task 5: Add `googleapis` dependency + build `gmail-client.js`

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `scripts/modules/gmail/gmail-client.js`
- Create: `tests/modules/gmail/gmail-client.test.js`

`gmail-client.js` is the only file that calls the Gmail API directly. It manages the OAuth2 client, handles token refresh, and exposes three operations: list emails, trash one email, trash many emails.

Each email object returned by `listEmails` has:
```
{ id, threadId, subject, from, snippet, date, labelIds, hasAttachment, listUnsubscribeHeader, inReplyTo }
```

- [ ] **Step 1: Install `googleapis`**

```bash
npm install googleapis
```

Expected: `package.json` updated with `"googleapis": "^..."` under dependencies.

- [ ] **Step 2: Write the failing tests**

Create `tests/modules/gmail/gmail-client.test.js`:

```js
// tests/modules/gmail/gmail-client.test.js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)
process.env.GOOGLE_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'

const mockSetCredentials = mock.fn()
const mockTokensHandler = { fn: null }
const mockMessagesList = mock.fn(async () => ({
  data: { messages: [{ id: 'msg1', threadId: 'thread1' }] },
}))
const mockMessagesGet = mock.fn(async ({ id }) => ({
  data: {
    id,
    threadId: 'thread1',
    labelIds: ['INBOX'],
    snippet: 'Hello world',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Test email' },
        { name: 'From', value: 'sender@example.com' },
        { name: 'Date', value: 'Mon, 16 Mar 2026 10:00:00 +0000' },
      ],
      parts: [],
    },
  },
}))
const mockMessagesTrash = mock.fn(async () => ({ data: {} }))

mock.module('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        constructor() {}
        setCredentials = mockSetCredentials
        on(event, fn) { if (event === 'tokens') mockTokensHandler.fn = fn }
      },
    },
    gmail: () => ({
      users: {
        messages: {
          list: mockMessagesList,
          get: mockMessagesGet,
          trash: mockMessagesTrash,
        },
      },
    }),
  },
}))

const { setSecret } = await import('../../../scripts/core/db.js')
setSecret('gmail_refresh_token', 'test-refresh-token')

const { listEmails, trashEmail, trashEmails } = await import('../../../scripts/modules/gmail/gmail-client.js')

beforeEach(() => {
  mockMessagesList.mock.resetCalls()
  mockMessagesGet.mock.resetCalls()
  mockMessagesTrash.mock.resetCalls()
})

describe('gmail-client.js', () => {
  it('listEmails returns an array of email objects with expected fields', async () => {
    const emails = await listEmails()
    assert.equal(emails.length, 1)
    assert.equal(emails[0].id, 'msg1')
    assert.equal(emails[0].subject, 'Test email')
    assert.equal(emails[0].from, 'sender@example.com')
    assert.equal(emails[0].snippet, 'Hello world')
    assert.equal(emails[0].hasAttachment, false)
    assert.equal(emails[0].listUnsubscribeHeader, null)
    assert.equal(emails[0].inReplyTo, null)
  })

  it('returns empty array when no messages', async () => {
    mockMessagesList.mock.mockImplementationOnce(async () => ({ data: {} }))
    const emails = await listEmails()
    assert.deepEqual(emails, [])
  })

  it('detects attachment by checking payload parts for non-empty filename', async () => {
    mockMessagesGet.mock.mockImplementationOnce(async ({ id }) => ({
      data: {
        id, threadId: 'thread1', labelIds: ['INBOX'], snippet: 'See attached',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'Subject', value: 'With attachment' },
            { name: 'From', value: 'a@b.com' },
            { name: 'Date', value: 'Mon, 16 Mar 2026 10:00:00 +0000' },
          ],
          parts: [
            { mimeType: 'text/plain', filename: '', headers: [] },
            { mimeType: 'application/pdf', filename: 'doc.pdf', headers: [] },
          ],
        },
      },
    }))
    const emails = await listEmails()
    assert.equal(emails[0].hasAttachment, true)
  })

  it('detects List-Unsubscribe header', async () => {
    mockMessagesGet.mock.mockImplementationOnce(async ({ id }) => ({
      data: {
        id, threadId: 'thread1', labelIds: ['CATEGORY_PROMOTIONS'], snippet: 'Sale',
        payload: {
          mimeType: 'text/html',
          headers: [
            { name: 'Subject', value: 'Big sale' },
            { name: 'From', value: 'promo@shop.com' },
            { name: 'Date', value: 'Mon, 16 Mar 2026 10:00:00 +0000' },
            { name: 'List-Unsubscribe', value: '<mailto:unsub@shop.com>' },
          ],
          parts: [],
        },
      },
    }))
    const emails = await listEmails()
    assert.ok(emails[0].listUnsubscribeHeader)
  })

  it('trashEmail calls Gmail trash API for one message', async () => {
    await trashEmail('msg1')
    assert.equal(mockMessagesTrash.mock.calls.length, 1)
    assert.equal(mockMessagesTrash.mock.calls[0].arguments[0].id, 'msg1')
  })

  it('trashEmails calls trash for each message and returns counts', async () => {
    await trashEmails(['msg1', 'msg2'])
    assert.equal(mockMessagesTrash.mock.calls.length, 2)
  })

  it('trashEmails returns { succeeded, failed } when some fail', async () => {
    mockMessagesTrash.mock.mockImplementationOnce(async () => { throw new Error('quota') })
    const result = await trashEmails(['fail-msg', 'ok-msg'])
    assert.equal(result.succeeded, 1)
    assert.equal(result.failed, 1)
  })
})
```

- [ ] **Step 3: Run to confirm failure**

```bash
node --experimental-test-module-mocks --test tests/modules/gmail/gmail-client.test.js
```

Expected: Fails — file doesn't exist.

- [ ] **Step 4: Implement `scripts/modules/gmail/gmail-client.js`**

```js
// scripts/modules/gmail/gmail-client.js
// All Gmail API calls go through here. Manages OAuth2 client and token refresh.
import { google } from 'googleapis'
import { getSecret, setSecret } from '../../core/db.js'
import { logger } from '../../core/logger.js'

function getOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  const refreshToken = getSecret('gmail_refresh_token')
  if (!refreshToken) {
    throw new Error('Gmail not authorized — run: source .env && node scripts/modules/gmail/setup.js')
  }
  client.setCredentials({ refresh_token: refreshToken })
  client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      setSecret('gmail_refresh_token', tokens.refresh_token)
      logger.info('gmail-client', 'token-rotated', 'refresh token updated')
    }
  })
  return client
}

function getGmailApi() {
  return google.gmail({ version: 'v1', auth: getOAuth2Client() })
}

function extractHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
}

function hasAttachmentParts(parts = []) {
  return parts.some(p => p.filename && p.filename.length > 0)
}

export async function listEmails({ maxResults = 50, query = 'is:unread -is:starred' } = {}) {
  const gmail = getGmailApi()
  const listRes = await gmail.users.messages.list({ userId: 'me', maxResults, q: query })
  const messages = listRes.data.messages ?? []
  if (messages.length === 0) return []

  const emails = await Promise.all(messages.map(async ({ id }) => {
    const msgRes = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
      fields: 'id,threadId,labelIds,snippet,payload(mimeType,headers,parts(filename,mimeType))',
    })
    const msg = msgRes.data
    const headers = msg.payload?.headers ?? []
    const parts = msg.payload?.parts ?? []
    return {
      id: msg.id,
      threadId: msg.threadId,
      subject: extractHeader(headers, 'Subject') ?? '(no subject)',
      from: extractHeader(headers, 'From') ?? '(unknown)',
      snippet: msg.snippet ?? '',
      date: extractHeader(headers, 'Date'),
      labelIds: msg.labelIds ?? [],
      hasAttachment: hasAttachmentParts(parts),
      listUnsubscribeHeader: extractHeader(headers, 'List-Unsubscribe'),
      inReplyTo: extractHeader(headers, 'In-Reply-To'),
    }
  }))
  return emails
}

export async function trashEmail(id) {
  const gmail = getGmailApi()
  await gmail.users.messages.trash({ userId: 'me', id })
}

export async function trashEmails(ids) {
  const gmail = getGmailApi()
  let succeeded = 0
  let failed = 0
  await Promise.all(ids.map(async (id) => {
    try {
      await gmail.users.messages.trash({ userId: 'me', id })
      succeeded++
    } catch (err) {
      logger.error('gmail-client', 'trash-failed', `${id}: ${err.message}`)
      failed++
    }
  }))
  return { succeeded, failed }
}
```

- [ ] **Step 5: Run tests to confirm pass**

```bash
node --experimental-test-module-mocks --test tests/modules/gmail/gmail-client.test.js
```

Expected: All tests pass.

- [ ] **Step 6: Run full suite**

```bash
node --experimental-test-module-mocks --test tests/**/*.test.js
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json scripts/modules/gmail/gmail-client.js tests/modules/gmail/gmail-client.test.js
git commit -m "feat: add gmail-client.js with OAuth2 token management and email operations"
```

---

### Task 6: `setup.js` — one-time OAuth setup script

**Files:**
- Create: `scripts/modules/gmail/setup.js`

A manual CLI script. No automated tests. Run on the **host** (not inside Docker) — it opens `http://localhost:8080/callback` in the user's browser and writes the refresh token to the SQLite DB at `DB_PATH`. The bot container mounts the same `./data` directory, so the token is immediately available.

Pre-conditions before running:
1. Google Cloud project created, Gmail API enabled
2. OAuth 2.0 credentials created (type: Desktop app)
3. `http://localhost:8080/callback` added as an authorized redirect URI in Google Cloud Console
4. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ENCRYPTION_KEY`, `DB_PATH` set in `.env`

- [ ] **Step 1: Create `scripts/modules/gmail/setup.js`**

```js
// scripts/modules/gmail/setup.js
// One-time OAuth setup. Run on the HOST (not in Docker):
//   source .env && node scripts/modules/gmail/setup.js
//
// Pre-conditions:
//   1. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ENCRYPTION_KEY, DB_PATH set in environment
//   2. http://localhost:8080/callback added as authorized redirect URI in Google Cloud Console
import { createServer } from 'node:http'
import { google } from 'googleapis'
import { setSecret } from '../../core/db.js'

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.')
  console.error('Run: source .env && node scripts/modules/gmail/setup.js')
  process.exit(1)
}
if (!process.env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY must be set. Generate: openssl rand -hex 32')
  process.exit(1)
}

const REDIRECT_URI = 'http://localhost:8080/callback'
const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI)

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/gmail.modify'],
  prompt: 'consent',
})

console.log('\nGmail OAuth Setup')
console.log('-'.repeat(50))
console.log('\nOpen this URL in your browser:\n')
console.log(authUrl)
console.log('\nWaiting for authorization at http://localhost:8080/callback ...\n')

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8080')
  const code = url.searchParams.get('code')
  const authError = url.searchParams.get('error')

  if (authError) {
    res.writeHead(400)
    res.end(`<html><body><h2>Authorization failed: ${authError}</h2></body></html>`)
    console.error(`Authorization failed: ${authError}`)
    server.close()
    process.exit(1)
  }

  if (!code) return

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<html><body><h2>Authorization successful! You can close this tab.</h2></body></html>')
  server.close()

  try {
    const { tokens } = await oauth2Client.getToken(code)
    if (!tokens.refresh_token) {
      console.error('No refresh_token returned.')
      console.error('Try revoking access at https://myaccount.google.com/permissions and re-running setup.')
      process.exit(1)
    }
    setSecret('gmail_refresh_token', tokens.refresh_token)
    console.log('Gmail authorized. Refresh token stored securely in SQLite.')
  } catch (err) {
    console.error('Failed to exchange authorization code:', err.message)
    process.exit(1)
  }
})

server.listen(8080, () => {})
```

- [ ] **Step 2: Commit**

```bash
git add scripts/modules/gmail/setup.js
git commit -m "feat: add gmail setup.js one-time OAuth authorization script"
```

---

## Chunk 3: Classification

### Task 7: `prompts.js` + `classifier.js` + tests

**Files:**
- Create: `scripts/modules/gmail/prompts.js`
- Create: `scripts/modules/gmail/classifier.js`
- Create: `tests/modules/gmail/classifier.test.js`

The classifier takes an array of email objects (from `gmail-client.js`) and returns `{ actionable, orders, deletable }` arrays. Rules are evaluated in priority order — first match wins. Everything else goes to Claude haiku in a single batch call.

Priority table:
1. `hasAttachment === true` → actionable (wins over all labels)
2. `inReplyTo` is non-null → actionable
3. `labelIds` includes `CATEGORY_PROMOTIONS` or `CATEGORY_SOCIAL` → deletable
4. `listUnsubscribeHeader` is non-null AND `inReplyTo` is null → deletable
5. No match → Claude haiku

Order age (post-Claude):
- `order` + age < 24h → actionable
- `order` + 24h–90d → silently kept (omitted from all lists)
- `order` + ≥90d → deletable

Starred emails: excluded before classification (never deleted).

- [ ] **Step 1: Create `scripts/modules/gmail/prompts.js`**

```js
// scripts/modules/gmail/prompts.js
// All Claude prompt strings for the gmail module.

export function buildClassificationPrompt(emails) {
  const emailList = emails.map((e, i) =>
    `${i + 1}. ID: ${e.id}\n   From: ${e.from}\n   Subject: ${e.subject}\n   Snippet: ${e.snippet}`
  ).join('\n\n')

  return `You are classifying emails for a personal inbox assistant. For each email, return one label:

- "actionable" — needs the user's attention (direct messages, important notices, alerts, invitations, tasks)
- "deletable" — no action needed, safe to trash (newsletters, social notifications, marketing)
- "order" — order confirmation, shipping notification, delivery update, or purchase receipt

Respond with a JSON array only — no markdown, no explanation. Example:
[{"id":"abc123","label":"actionable","reason":"Direct email from a person"},{"id":"def456","label":"deletable","reason":"LinkedIn notification"}]

Emails to classify:

${emailList}`
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/modules/gmail/classifier.test.js`:

```js
// tests/modules/gmail/classifier.test.js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)
process.env.ANTHROPIC_API_KEY = 'test-key'

const mockAsk = mock.fn(async () => '[]')
mock.module('../../scripts/core/claude.js', () => ({ ask: mockAsk }))

const { classify } = await import('../../scripts/modules/gmail/classifier.js')

function makeEmail(overrides = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    subject: 'Test email',
    from: 'someone@example.com',
    snippet: 'Hello',
    date: new Date().toUTCString(),
    labelIds: ['INBOX'],
    hasAttachment: false,
    listUnsubscribeHeader: null,
    inReplyTo: null,
    ...overrides,
  }
}

beforeEach(() => mockAsk.mock.resetCalls())

describe('classifier.js — rule-based pass', () => {
  it('attachment is actionable (rule 1) regardless of label', async () => {
    const result = await classify([makeEmail({ hasAttachment: true, labelIds: ['CATEGORY_PROMOTIONS'] })])
    assert.equal(result.actionable.length, 1)
    assert.equal(result.deletable.length, 0)
    assert.equal(mockAsk.mock.calls.length, 0)
  })

  it('In-Reply-To header is actionable (rule 2)', async () => {
    const result = await classify([makeEmail({ inReplyTo: '<prev@example.com>' })])
    assert.equal(result.actionable.length, 1)
    assert.equal(mockAsk.mock.calls.length, 0)
  })

  it('CATEGORY_PROMOTIONS with no attachment is deletable (rule 3)', async () => {
    const result = await classify([makeEmail({ labelIds: ['CATEGORY_PROMOTIONS'] })])
    assert.equal(result.deletable.length, 1)
    assert.equal(mockAsk.mock.calls.length, 0)
  })

  it('CATEGORY_SOCIAL is deletable (rule 3)', async () => {
    const result = await classify([makeEmail({ labelIds: ['CATEGORY_SOCIAL'] })])
    assert.equal(result.deletable.length, 1)
  })

  it('List-Unsubscribe with no reply-to is deletable (rule 4)', async () => {
    const result = await classify([makeEmail({ listUnsubscribeHeader: '<mailto:u@s.com>' })])
    assert.equal(result.deletable.length, 1)
    assert.equal(mockAsk.mock.calls.length, 0)
  })

  it('attachment wins over CATEGORY_PROMOTIONS (rule 1 beats rule 3)', async () => {
    const result = await classify([makeEmail({ hasAttachment: true, labelIds: ['CATEGORY_PROMOTIONS'] })])
    assert.equal(result.actionable.length, 1)
    assert.equal(result.deletable.length, 0)
  })

  it('starred email is excluded from all results regardless of label', async () => {
    const result = await classify([makeEmail({ labelIds: ['STARRED', 'CATEGORY_PROMOTIONS'] })])
    assert.equal(result.actionable.length, 0)
    assert.equal(result.deletable.length, 0)
    assert.equal(result.orders.length, 0)
  })
})

describe('classifier.js — order age logic', () => {
  it('order < 24h is actionable', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toUTCString() // 1h ago
    mockAsk.mock.mockImplementationOnce(async () =>
      JSON.stringify([{ id: 'msg-1', label: 'order', reason: 'shipping' }])
    )
    const result = await classify([makeEmail({ id: 'msg-1', date: recent })])
    assert.equal(result.actionable.length, 1)
  })

  it('order 24h-90d is silently kept (not in any output list)', async () => {
    const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toUTCString() // 5 days ago
    mockAsk.mock.mockImplementationOnce(async () =>
      JSON.stringify([{ id: 'msg-1', label: 'order', reason: 'old' }])
    )
    const result = await classify([makeEmail({ id: 'msg-1', date: old })])
    assert.equal(result.actionable.length, 0)
    assert.equal(result.deletable.length, 0)
    assert.equal(result.orders.length, 0)
  })

  it('order >= 90d is deletable', async () => {
    const veryOld = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toUTCString()
    mockAsk.mock.mockImplementationOnce(async () =>
      JSON.stringify([{ id: 'msg-1', label: 'order', reason: 'very old receipt' }])
    )
    const result = await classify([makeEmail({ id: 'msg-1', date: veryOld })])
    assert.equal(result.deletable.length, 1)
  })
})

describe('classifier.js — Claude fallback', () => {
  it('ambiguous emails are sent to Claude', async () => {
    mockAsk.mock.mockImplementationOnce(async () =>
      JSON.stringify([{ id: 'msg-1', label: 'actionable', reason: 'direct email' }])
    )
    const result = await classify([makeEmail()])
    assert.equal(mockAsk.mock.calls.length, 1)
    assert.equal(result.actionable.length, 1)
  })

  it('Claude failure degrades gracefully — omits ambiguous emails, does not throw', async () => {
    mockAsk.mock.mockImplementationOnce(async () => { throw new Error('API error') })
    const result = await classify([makeEmail()])
    assert.equal(result.actionable.length, 0)
    assert.equal(result.deletable.length, 0)
  })

  it('skips Claude entirely when all emails matched rules', async () => {
    await classify([
      makeEmail({ labelIds: ['CATEGORY_PROMOTIONS'] }),
      makeEmail({ id: 'msg-2', hasAttachment: true }),
    ])
    assert.equal(mockAsk.mock.calls.length, 0)
  })
})
```

- [ ] **Step 3: Run to confirm failure**

```bash
node --experimental-test-module-mocks --test tests/modules/gmail/classifier.test.js
```

Expected: Fails — files don't exist.

- [ ] **Step 4: Implement `scripts/modules/gmail/classifier.js`**

```js
// scripts/modules/gmail/classifier.js
// Rule-based email classification with Claude haiku fallback for ambiguous emails.
import { ask } from '../../core/claude.js'
import { logger } from '../../core/logger.js'
import { buildClassificationPrompt } from './prompts.js'

const MS_24H = 24 * 60 * 60 * 1000
const MS_90D = 90 * 24 * 60 * 60 * 1000

function emailAgeMs(dateStr) {
  if (!dateStr) return Infinity
  const parsed = Date.parse(dateStr)
  return isNaN(parsed) ? Infinity : Date.now() - parsed
}

// Returns 'actionable', 'deletable', or null (ambiguous — send to Claude).
// Rules are evaluated in priority order: first match wins.
function applyRules(email) {
  if (email.hasAttachment) return 'actionable'                                          // rule 1
  if (email.inReplyTo) return 'actionable'                                              // rule 2
  if (email.labelIds.includes('CATEGORY_PROMOTIONS') ||
      email.labelIds.includes('CATEGORY_SOCIAL')) return 'deletable'                   // rule 3
  if (email.listUnsubscribeHeader && !email.inReplyTo) return 'deletable'              // rule 4
  return null
}

export async function classify(emails) {
  const actionable = []
  const orders = []
  const deletable = []
  const ambiguous = []

  for (const email of emails) {
    if (email.labelIds.includes('STARRED')) continue // never delete starred

    const rule = applyRules(email)
    if (rule === 'actionable') { actionable.push(email); continue }
    if (rule === 'deletable')  { deletable.push(email);  continue }
    ambiguous.push(email)
  }

  if (ambiguous.length === 0) return { actionable, orders, deletable }

  let claudeResults = []
  try {
    const prompt = buildClassificationPrompt(ambiguous)
    const raw = await ask(prompt, 'haiku', { module: 'gmail', maxTokens: 2048 })
    claudeResults = JSON.parse(raw)
  } catch (err) {
    logger.warn('gmail', 'classify-claude-failed', err.message)
    return { actionable, orders, deletable } // graceful degradation
  }

  const resultMap = new Map(claudeResults.map(r => [r.id, r.label]))

  for (const email of ambiguous) {
    const label = resultMap.get(email.id)
    if (label === 'actionable') {
      actionable.push(email)
    } else if (label === 'order') {
      const age = emailAgeMs(email.date)
      if (age < MS_24H) {
        actionable.push(email)       // recent order in digest
      } else if (age >= MS_90D) {
        deletable.push(email)        // old order in deletion batch
      }
      // 24h–90d: silently kept
    } else if (label === 'deletable') {
      deletable.push(email)
    }
    // undefined/unknown label: silently omitted
  }

  return { actionable, orders, deletable }
}
```

- [ ] **Step 5: Run tests to confirm pass**

```bash
node --experimental-test-module-mocks --test tests/modules/gmail/classifier.test.js
```

Expected: All tests pass.

- [ ] **Step 6: Run full suite**

```bash
node --experimental-test-module-mocks --test tests/**/*.test.js
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/modules/gmail/prompts.js scripts/modules/gmail/classifier.js tests/modules/gmail/classifier.test.js
git commit -m "feat: add gmail classifier.js with rule-based pass and Claude haiku fallback"
```

---

## Chunk 4: Module Entry Point

### Task 8: `index.js` — digest flow + tests

**Files:**
- Create: `scripts/modules/gmail/index.js`
- Create: `tests/modules/gmail/index.test.js`

`run({ action })` is the main entry point — `action` is `'digest'` (default) or `'deletion'`. The module also exports `handleCallback(callbackQuery)` for all `gmail_*` button presses, and registers HTTP routes using `registerRoute()`.

All email subjects and sender names are HTML-escaped before passing to `telegram.send()` — it uses `parse_mode: 'HTML'`.

- [ ] **Step 1: Write the failing digest tests**

Create `tests/modules/gmail/index.test.js`:

```js
// tests/modules/gmail/index.test.js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_CHAT_ID = '123'
process.env.ANTHROPIC_API_KEY = 'test-key'

const fetchMock = mock.fn(async () => ({ ok: true, json: async () => ({}) }))
global.fetch = fetchMock

const mockListEmails = mock.fn(async () => [])
const mockTrashEmail = mock.fn(async () => {})
const mockTrashEmails = mock.fn(async () => ({ succeeded: 0, failed: 0 }))
mock.module('../../scripts/modules/gmail/gmail-client.js', () => ({
  listEmails: mockListEmails,
  trashEmail: mockTrashEmail,
  trashEmails: mockTrashEmails,
}))

const mockClassify = mock.fn(async () => ({ actionable: [], orders: [], deletable: [] }))
mock.module('../../scripts/modules/gmail/classifier.js', () => ({ classify: mockClassify }))

// Mock http-server to avoid side-effects from registerRoute
mock.module('../../scripts/system/http-server.js', () => ({ registerRoute: () => {} }))

const { run, handleCallback } = await import('../../scripts/modules/gmail/index.js')
const { getDb, run: dbRun } = await import('../../scripts/core/db.js')

function makeEmail(overrides = {}) {
  return {
    id: 'msg-1',
    subject: 'Test subject',
    from: 'Sender Name <sender@example.com>',
    snippet: 'Snippet',
    date: new Date().toUTCString(),
    labelIds: ['INBOX'],
    ...overrides,
  }
}

function getSendCalls() {
  return fetchMock.mock.calls.filter(c => String(c.arguments[0]).includes('sendMessage'))
}

beforeEach(() => {
  fetchMock.mock.resetCalls()
  mockListEmails.mock.resetCalls()
  mockClassify.mock.resetCalls()
  mockTrashEmails.mock.resetCalls()
  getDb().prepare('DELETE FROM pending_confirmations').run()
  getDb().prepare('DELETE FROM audit_log').run()
  getDb().prepare('DELETE FROM module_status').run()
})

describe('index.js — digest', () => {
  it('sends "Inbox clear" when no actionable emails or orders', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [makeEmail()])
    mockClassify.mock.mockImplementationOnce(async () => ({ actionable: [], orders: [], deletable: [] }))
    await run({ action: 'digest' })
    const text = JSON.parse(getSendCalls()[0].arguments[1].body).text
    assert.ok(text.includes('Inbox clear'))
  })

  it('digest includes actionable section', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [makeEmail()])
    mockClassify.mock.mockImplementationOnce(async () => ({
      actionable: [makeEmail({ subject: 'Meeting request', from: 'boss@work.com' })],
      orders: [],
      deletable: [],
    }))
    await run({ action: 'digest' })
    const text = JSON.parse(getSendCalls()[0].arguments[1].body).text
    assert.ok(text.includes('Actionable'))
    assert.ok(text.includes('Meeting request'))
  })

  it('digest includes orders section for recent orders', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [makeEmail()])
    mockClassify.mock.mockImplementationOnce(async () => ({
      actionable: [],
      orders: [makeEmail({ subject: 'Your order shipped' })],
      deletable: [],
    }))
    await run({ action: 'digest' })
    const text = JSON.parse(getSendCalls()[0].arguments[1].body).text
    assert.ok(text.includes('Orders') || text.includes('shipped'))
  })

  it('HTML-escapes subjects and sender names', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [makeEmail()])
    mockClassify.mock.mockImplementationOnce(async () => ({
      actionable: [makeEmail({ subject: '<b>xss</b>', from: 'A&B <a@b.com>' })],
      orders: [],
      deletable: [],
    }))
    await run({ action: 'digest' })
    const text = JSON.parse(getSendCalls()[0].arguments[1].body).text
    assert.ok(!text.includes('<b>xss</b>'))
    assert.ok(text.includes('&lt;b&gt;'))
    assert.ok(text.includes('A&amp;B'))
  })

  it('defaults to digest when no action provided', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [])
    mockClassify.mock.mockImplementationOnce(async () => ({ actionable: [], orders: [], deletable: [] }))
    await run({})
    assert.equal(mockListEmails.mock.calls.length, 1)
  })

  it('records heartbeat on success', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [])
    mockClassify.mock.mockImplementationOnce(async () => ({ actionable: [], orders: [], deletable: [] }))
    await run({ action: 'digest' })
    const status = getDb().prepare("SELECT * FROM module_status WHERE module = 'gmail'").get()
    assert.ok(status)
    assert.equal(status.consecutive_errors, 0)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
node --experimental-test-module-mocks --test tests/modules/gmail/index.test.js
```

Expected: Fails — file doesn't exist.

- [ ] **Step 3: Implement digest path in `scripts/modules/gmail/index.js`**

```js
// scripts/modules/gmail/index.js
import { heartbeat, error as statusError } from '../../core/status.js'
import { logger } from '../../core/logger.js'
import { auditLog, run as dbRun, queryOne } from '../../core/db.js'
import { send, sendWithButtons } from '../../core/telegram.js'
import { registerRoute } from '../../system/http-server.js'
import { listEmails, trashEmail, trashEmails } from './gmail-client.js'
import { classify } from './classifier.js'

// Register HTTP routes for n8n scheduled triggers
registerRoute('POST', '/gmail/digest', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  run({ action: 'digest' }).catch(err => logger.error('gmail', 'http-digest-error', err.message))
})

registerRoute('POST', '/gmail/deletion', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  run({ action: 'deletion' }).catch(err => logger.error('gmail', 'http-deletion-error', err.message))
})

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function senderName(from) {
  return esc(from.replace(/<[^>]+>/, '').trim() || from)
}

function formatAge(dateStr) {
  if (!dateStr) return ''
  const ms = Date.now() - Date.parse(dateStr)
  if (isNaN(ms) || ms < 0) return ''
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return '(just now)'
  if (h < 24) return `(${h}h ago)`
  return `(${Math.floor(h / 24)}d ago)`
}

async function runDigest() {
  const rawEmails = await listEmails()
  const { actionable, orders, deletable } = rawEmails.length
    ? await classify(rawEmails)
    : { actionable: [], orders: [], deletable: [] }

  if (actionable.length === 0 && orders.length === 0) {
    await send('✅ Inbox clear')
    auditLog('gmail', 'digest', { actionable: 0, orders: 0, deletable_count: deletable.length })
    return
  }

  const now = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
  const lines = [`📧 <b>Gmail Digest</b> — ${now}`]

  if (actionable.length > 0) {
    lines.push(`\n🔴 <b>Actionable (${actionable.length})</b>`)
    for (const e of actionable) {
      lines.push(`• ${senderName(e.from)} — "${esc(e.subject)}" ${formatAge(e.date)}`)
    }
  }

  if (orders.length > 0) {
    lines.push(`\n📦 <b>Orders (${orders.length})</b>`)
    for (const e of orders) {
      lines.push(`• ${senderName(e.from)} — "${esc(e.subject)}" ${formatAge(e.date)}`)
    }
  }

  lines.push('\n✅ Nothing else needs your attention')

  await send(lines.join('\n'))
  auditLog('gmail', 'digest', { actionable: actionable.length, orders: orders.length, deletable_count: deletable.length })
}

async function runDeletion() {
  // Implemented in Task 9
  logger.info('gmail', 'deletion-stub', 'not yet implemented')
}

export async function run(input = {}) {
  const action = input.action ?? 'digest'
  try {
    if (action === 'deletion') {
      await runDeletion()
    } else {
      await runDigest()
    }
    await heartbeat('gmail')
  } catch (err) {
    await statusError('gmail', err)
    throw err
  }
}

export async function handleCallback(callbackQuery) {
  // Implemented in Task 9
  logger.info('gmail', 'handleCallback-stub', callbackQuery.data)
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
node --experimental-test-module-mocks --test tests/modules/gmail/index.test.js
```

Expected: All digest tests pass.

- [ ] **Step 5: Run full suite**

```bash
node --experimental-test-module-mocks --test tests/**/*.test.js
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/modules/gmail/index.js tests/modules/gmail/index.test.js
git commit -m "feat: add gmail index.js digest flow with HTTP route registration"
```

---

### Task 9: `index.js` — deletion batch + `handleCallback` + tests

**Files:**
- Modify: `scripts/modules/gmail/index.js` (replace stubs)
- Modify: `tests/modules/gmail/index.test.js` (add deletion + handleCallback tests)

- [ ] **Step 1: Add failing tests**

Append to `tests/modules/gmail/index.test.js`:

```js
describe('index.js — deletion batch', () => {
  it('sends no message when no deletable emails exist', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [])
    mockClassify.mock.mockImplementationOnce(async () => ({ actionable: [], orders: [], deletable: [] }))
    await run({ action: 'deletion' })
    assert.equal(getSendCalls().length, 0)
  })

  it('sends deletion prompt with 3 buttons when deletable emails exist', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [makeEmail()])
    mockClassify.mock.mockImplementationOnce(async () => ({
      actionable: [], orders: [],
      deletable: [makeEmail(), makeEmail({ id: 'msg-2' })],
    }))
    await run({ action: 'deletion' })
    const call = getSendCalls()[0]
    const body = JSON.parse(call.arguments[1].body)
    const buttons = body.reply_markup.inline_keyboard[0].map(b => b.text)
    assert.ok(buttons.some(b => b.includes('Delete All')))
    assert.ok(buttons.some(b => b.includes('Review')))
    assert.ok(buttons.some(b => b.includes('Skip')))
  })

  it('stores message IDs in pending_confirmations', async () => {
    mockListEmails.mock.mockImplementationOnce(async () => [makeEmail()])
    mockClassify.mock.mockImplementationOnce(async () => ({
      actionable: [], orders: [],
      deletable: [makeEmail({ id: 'del-msg-1' })],
    }))
    await run({ action: 'deletion' })
    const row = getDb().prepare("SELECT data FROM pending_confirmations WHERE module = 'gmail'").get()
    assert.ok(row)
    const ids = JSON.parse(row.data)
    assert.ok(ids.includes('del-msg-1'))
  })
})

describe('index.js — handleCallback', () => {
  it('gmail_skip deletes the pending_confirmations row', async () => {
    const batchId = '9999'
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'gmail', 'test', ?, ?)",
      [batchId, JSON.stringify(['msg1']), Math.floor(Date.now() / 1000) + 300]
    )
    await handleCallback({ id: 'cq1', data: `gmail_skip_${batchId}` })
    const row = getDb().prepare('SELECT * FROM pending_confirmations WHERE action_id = ?').get(batchId)
    assert.equal(row, undefined)
  })

  it('gmail_delete_all trashes emails and sends confirmation', async () => {
    const batchId = '8888'
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'gmail', 'test', ?, ?)",
      [batchId, JSON.stringify(['msg1', 'msg2']), Math.floor(Date.now() / 1000) + 300]
    )
    mockTrashEmails.mock.mockImplementationOnce(async () => ({ succeeded: 2, failed: 0 }))
    await handleCallback({ id: 'cq1', data: `gmail_delete_all_${batchId}` })
    assert.equal(mockTrashEmails.mock.calls.length, 1)
    assert.ok(getSendCalls().length > 0)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
node --experimental-test-module-mocks --test tests/modules/gmail/index.test.js
```

Expected: New deletion and handleCallback tests fail.

- [ ] **Step 3: Replace stubs in `scripts/modules/gmail/index.js`**

Replace the `runDeletion` stub function:

```js
async function runDeletion() {
  const rawEmails = await listEmails()
  const { deletable } = rawEmails.length
    ? await classify(rawEmails)
    : { deletable: [] }

  if (deletable.length === 0) return

  const batch = deletable.slice(0, 50)
  const batchId = String(Date.now())

  dbRun(
    `INSERT INTO pending_confirmations (action_id, module, description, data, expires_at)
     VALUES (?, 'gmail', ?, ?, ?)
     ON CONFLICT(action_id) DO NOTHING`,
    [batchId, `Deletion batch of ${batch.length} email${batch.length !== 1 ? 's' : ''}`,
     JSON.stringify(batch.map(e => e.id)),
     Math.floor(Date.now() / 1000) + 300]
  )

  const lines = [`🗑 <b>Deletion suggestions</b> — ${batch.length} email${batch.length !== 1 ? 's' : ''}\n`]
  batch.slice(0, 10).forEach((e, i) => {
    lines.push(`${i + 1}. ${senderName(e.from)} — "${esc(e.subject)}" ${formatAge(e.date)}`)
  })
  if (batch.length > 10) lines.push(`... and ${batch.length - 10} more`)

  await sendWithButtons(lines.join('\n'), [[
    { text: '🗑 Delete All', callback_data: `gmail_delete_all_${batchId}` },
    { text: '👀 Review',     callback_data: `gmail_review_${batchId}` },
    { text: '⏭ Skip Today', callback_data: `gmail_skip_${batchId}` },
  ]])

  auditLog('gmail', 'deletion_prompt', { count: batch.length, batchId })
}
```

Replace the `handleCallback` stub:

```js
export async function handleCallback(callbackQuery) {
  const { data } = callbackQuery

  if (data.startsWith('gmail_skip_')) {
    const batchId = data.slice('gmail_skip_'.length)
    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [batchId])
    auditLog('gmail', 'deletion_skipped', { batchId })
    return
  }

  if (data.startsWith('gmail_delete_all_')) {
    const batchId = data.slice('gmail_delete_all_'.length)
    const row = queryOne('SELECT data FROM pending_confirmations WHERE action_id = ?', [batchId])
    if (!row) return
    const ids = JSON.parse(row.data)
    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [batchId])
    auditLog('gmail', 'delete_batch_start', { count: ids.length, batchId })
    const { succeeded, failed } = await trashEmails(ids)
    auditLog('gmail', 'delete_batch_complete', { succeeded, failed, batchId })
    await send(failed === 0
      ? `🗑 Trashed ${succeeded} email${succeeded !== 1 ? 's' : ''}`
      : `🗑 Trashed ${succeeded}, ${failed} failed — check logs`)
    return
  }

  if (data.startsWith('gmail_review_')) {
    const batchId = data.slice('gmail_review_'.length)
    const row = queryOne('SELECT data FROM pending_confirmations WHERE action_id = ?', [batchId])
    if (!row) return
    const ids = JSON.parse(row.data)
    dbRun('DELETE FROM pending_confirmations WHERE action_id = ?', [batchId])
    for (const id of ids) {
      await sendWithButtons(`📧 Message: <code>${esc(id)}</code>`, [[
        { text: '🗑 Trash', callback_data: `gmail_trash_${id}` },
        { text: '✅ Keep',  callback_data: `gmail_keep_${id}` },
      ]])
    }
    return
  }

  if (data.startsWith('gmail_trash_')) {
    const msgId = data.slice('gmail_trash_'.length)
    auditLog('gmail', 'trash_single', { msgId })
    await trashEmail(msgId)
    auditLog('gmail', 'trash_single_complete', { msgId })
    return
  }

  if (data.startsWith('gmail_keep_')) {
    const msgId = data.slice('gmail_keep_'.length)
    auditLog('gmail', 'keep_single', { msgId })
    return
  }

  logger.warn('gmail', 'handleCallback-unknown', data)
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
node --experimental-test-module-mocks --test tests/modules/gmail/index.test.js
```

Expected: All tests pass.

- [ ] **Step 5: Run full suite**

```bash
node --experimental-test-module-mocks --test tests/**/*.test.js
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/modules/gmail/index.js tests/modules/gmail/index.test.js
git commit -m "feat: add gmail deletion batch and handleCallback"
```

---

## Chunk 5: Wiring, Config, Workflows, and PR

### Task 10: Wire bot entry point and router

**Files:**
- Modify: `scripts/system/telegram-router-main.js`
- Modify: `scripts/system/telegram-router.js`
- Modify: `scripts/modules/gmail/index.js` (no new code — routes already registered at import time in Task 8)

- [ ] **Step 1: Update `scripts/system/telegram-router-main.js`**

Replace the existing content with:

```js
// Entry point for the Telegram polling bot Docker service.
// Kept separate so telegram-router.js is safe to import in tests.
import { start } from './telegram-router.js'
import { cleanExpired } from './confirm-timeout.js'
import { startHttpServer } from './http-server.js'

// Import modules to trigger registerRoute() side-effects
import '../modules/gmail/index.js'

// HTTP server for n8n scheduled triggers — must start before polling loop
startHttpServer(3000)

// Run confirmation timeout cleanup every 60 seconds
setInterval(() => { cleanExpired().catch(() => {}) }, 60_000)

start()
```

- [ ] **Step 2: Wire default fallback in `scripts/system/telegram-router.js`**

In `handleUpdate()`, replace the final `else` stub comment:

```js
} else {
  // Default fallback: any unrecognized message triggers gmail digest
  const mod = await import('../modules/gmail/index.js')
  await mod.run({ action: 'digest', message })
}
```

- [ ] **Step 3: Run full test suite**

```bash
node --experimental-test-module-mocks --test tests/**/*.test.js
```

Expected: All tests pass. (`telegram-router-main.js` is never imported in tests — the entry point runs only in production.)

- [ ] **Step 4: Commit**

```bash
git add scripts/system/telegram-router-main.js scripts/system/telegram-router.js
git commit -m "feat: wire http-server and gmail module into bot entry point; wire default router fallback to gmail digest"
```

---

### Task 11: Update `docker-compose.yml` and `.env.example`

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: Add new env vars to `docker-compose.yml` bot service environment block**

```yaml
- ENCRYPTION_KEY=${ENCRYPTION_KEY}
- GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
- GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
```

- [ ] **Step 2: Update `.env.example`**

Add after the existing `ANTHROPIC_API_KEY` entry:

```bash
# 32-byte hex key for AES-256-GCM encrypted secret storage (OAuth tokens, etc.)
# Generate: openssl rand -hex 32
export ENCRYPTION_KEY=

# Google OAuth 2.0 credentials for Gmail API
# Setup: console.cloud.google.com → enable Gmail API → create Desktop app credentials
# Add http://localhost:8080/callback as an authorized redirect URI
export GOOGLE_CLIENT_ID=
export GOOGLE_CLIENT_SECRET=
# After setting the above, run: source .env && node scripts/modules/gmail/setup.js
# Google OAuth refresh token is stored AES-256-GCM encrypted in SQLite (not in .env)
```

Remove (or update) the stale comment at the bottom:
```
# Google OAuth is managed via n8n credential vault — no env vars needed here
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: add ENCRYPTION_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET to docker-compose and .env.example"
```

---

### Task 12: n8n workflow JSON files

**Files:**
- Create: `workflows/modules/gmail-digest.json`
- Create: `workflows/modules/gmail-deletion.json`

> **Note:** After creating these files, import them in the n8n UI (menu → Import Workflow), verify the schedule and URL, activate, and re-export if n8n modifies the JSON on import.

- [ ] **Step 1: Create `workflows/modules/gmail-digest.json`**

```json
{
  "name": "Gmail Digest",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [{ "field": "cronExpression", "expression": "30 7 * * *" }]
        }
      },
      "id": "gmail-digest-trigger",
      "name": "Schedule Trigger",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [240, 300]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://bot:3000/gmail/digest",
        "options": { "timeout": 5000 }
      },
      "id": "gmail-digest-request",
      "name": "HTTP Request",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [460, 300]
    }
  ],
  "connections": {
    "Schedule Trigger": {
      "main": [[{ "node": "HTTP Request", "type": "main", "index": 0 }]]
    }
  },
  "settings": { "executionOrder": "v1" }
}
```

- [ ] **Step 2: Create `workflows/modules/gmail-deletion.json`**

Same structure but:
- `"name": "Gmail Deletion Suggestions"`
- cron expression: `"0 17 * * *"` (5:00 PM daily)
- url: `"http://bot:3000/gmail/deletion"`
- ids: `gmail-deletion-trigger`, `gmail-deletion-request`

- [ ] **Step 3: Commit**

```bash
git add workflows/modules/gmail-digest.json workflows/modules/gmail-deletion.json
git commit -m "feat: add n8n workflow JSON files for gmail digest (7:30 AM) and deletion (5 PM)"
```

---

### Task 13: CHANGELOG + PR

- [ ] **Step 1: Add CHANGELOG entry under `## [Unreleased]` → `### Added`**

```markdown
- Gmail module: daily digest at 7:30 AM and on-demand `gmail` Telegram command — surfaces actionable emails and recent orders with Claude haiku classification fallback
- Gmail module: 5 PM deletion batch — identifies promotions, social notifications, and orders >90 days; presents [Delete All] / [Review] / [Skip Today] prompt
- `core/db.js`: `setSecret(key, value)` / `getSecret(key)` — AES-256-GCM encrypted secret storage
- `scripts/system/http-server.js`: reusable HTTP server for n8n scheduled triggers; modules call `registerRoute()` to register endpoints
- `scripts/modules/gmail/setup.js`: one-time OAuth CLI script to authorize Gmail and store refresh token encrypted in SQLite
- n8n workflows `workflows/modules/gmail-digest.json` and `workflows/modules/gmail-deletion.json`
- New env vars: `ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
```

- [ ] **Step 2: Run final test suite**

```bash
node --experimental-test-module-mocks --test tests/**/*.test.js
```

Expected: All tests pass.

- [ ] **Step 3: Commit CHANGELOG**

```bash
git add CHANGELOG.md
git commit -m "docs: add Phase 1 Gmail CHANGELOG entry"
```

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin phase-1-gmail
gh pr create --title "Phase 1: Gmail module — digest, deletion batch, http-server"
```

PR body should include:
- Summary of what was built
- Pre-merge manual steps: generate ENCRYPTION_KEY, set up Google Cloud OAuth, run setup.js, rebuild bot container, import and activate n8n workflows
- Test plan: npm test passes, gmail command returns digest, 5 PM deletion prompt appears, Delete All moves to Trash, status shows gmail as healthy

---

*Plan complete. All tasks follow TDD: failing test → confirm failure → implement → confirm pass → commit.*
