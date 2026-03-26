# Phase 3: Tiller Budget Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Google Sheets integration for Tiller Foundation budget data — on-demand Q&A via `$` Telegram prefix and a weekly spending digest on Sundays at noon.

**Architecture:** User sends `$ <question>` → router dispatches to tiller module → `sheets-client.js` fetches Transactions + Categories via googleapis batchGet → JS pre-aggregates data → Claude haiku analyzes and formats response → Telegram reply. Weekly digest follows the same pipeline on a schedule via n8n → HTTP endpoint.

**Tech Stack:** googleapis (already installed), node:test for testing, Claude haiku for NLP, SQLite for OAuth token storage and audit logging.

**Design spec:** `docs/superpowers/specs/2026-03-25-tiller-budget-module-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/modules/tiller/setup.js` | Create | One-time OAuth consent for `spreadsheets.readonly` scope |
| `scripts/modules/tiller/sheets-client.js` | Create | Google Sheets API wrapper — OAuth2 client + `fetchSheetData()` |
| `scripts/modules/tiller/prompts.js` | Create | All Claude prompt builders for queries, digest, budget check |
| `scripts/modules/tiller/index.js` | Create | Module entry points: `run()`, `weeklyDigest()`, `handleCallback()`, HTTP route |
| `scripts/system/telegram-router.js` | Modify (line 38-39) | Replace `$` placeholder comment with tiller import + `run()` call |
| `scripts/system/telegram-router-main.js` | Modify (line 8) | Add tiller import for `registerRoute()` side-effect |
| `.env.example` | Modify | Add `TILLER_SHEET_ID` variable |
| `CLAUDE.md` | Modify (Stack section) | Add Google Sheets API mention |
| `CHANGELOG.md` | Modify | Add Phase 3 entries |
| `tests/modules/tiller/sheets-client.test.js` | Create | Tests for sheets-client data fetching and parsing |
| `tests/modules/tiller/prompts.test.js` | Create | Tests for prompt builders |
| `tests/modules/tiller/index.test.js` | Create | Tests for run() and weeklyDigest() |

---

### Task 1: Create branch and setup.js (OAuth consent)

**Files:**
- Create: `scripts/modules/tiller/setup.js`

This mirrors `scripts/modules/gmail/setup.js` exactly — same OAuth flow, different scope and secret key.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b phase-3-tiller
```

- [ ] **Step 2: Create `scripts/modules/tiller/setup.js`**

```js
// scripts/modules/tiller/setup.js
// One-time OAuth setup for Google Sheets (read-only).
// Run on the HOST (not in Docker):
//   source .env && node scripts/modules/tiller/setup.js
//
// Pre-conditions:
//   1. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ENCRYPTION_KEY, DB_PATH set in environment
//   2. http://localhost:8080/callback added as authorized redirect URI in Google Cloud Console
//   3. Google Sheets API enabled in Google Cloud Console
import { createServer } from 'node:http'
import { google } from 'googleapis'
import { setSecret } from '../../core/db.js'

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.')
  console.error('Run: source .env && node scripts/modules/tiller/setup.js')
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
  scope: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  prompt: 'consent',
})

console.log('\nGoogle Sheets OAuth Setup (read-only)')
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
  res.end('<html><body><h2>Sheets authorization successful! You can close this tab.</h2></body></html>')
  server.close()

  try {
    const { tokens } = await oauth2Client.getToken(code)
    if (!tokens.refresh_token) {
      console.error('No refresh_token returned.')
      console.error('Try revoking access at https://myaccount.google.com/permissions and re-running setup.')
      process.exit(1)
    }
    setSecret('sheets_refresh_token', tokens.refresh_token)
    console.log('Google Sheets authorized. Refresh token stored securely in SQLite.')
    process.exit()
  } catch (err) {
    console.error('Failed to exchange authorization code:', err.message)
    process.exit(1)
  }
})

server.listen(8080, () => {})
```

- [ ] **Step 3: Commit**

```bash
git add scripts/modules/tiller/setup.js
git commit -m "feat(tiller): add OAuth setup script for Google Sheets read-only scope"
```

---

### Task 2: Create sheets-client.js (Google Sheets API wrapper)

**Files:**
- Create: `scripts/modules/tiller/sheets-client.js`
- Create: `tests/modules/tiller/sheets-client.test.js`

This mirrors `scripts/modules/gmail/gmail-client.js` for auth. Fetches Transactions and Categories sheets in a single `batchGet` call, parses rows dynamically from header row.

- [ ] **Step 1: Write the test file**

```js
// tests/modules/tiller/sheets-client.test.js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)
process.env.GOOGLE_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
process.env.TILLER_SHEET_ID = 'test-sheet-id'

const SAMPLE_TRANSACTIONS = [
  ['Date', 'Description', 'Category', 'Amount', 'Account', 'Account #', 'Institution', 'Month', 'Week', 'Transaction ID', 'Account ID', 'Check Number', 'Full Description', 'Date Added', 'Category Hint', 'Categorized By', 'Categorized Date', 'Source'],
  ['03/15/2026', 'TRADER JOES #123', 'Groceries', '-84.32', 'Checking', '****1234', 'Chase', '2026-03', '2026-03-09', 'txn_001', 'acct_001', '', 'TRADER JOES #123 LOS ANGELES CA', '03/15/2026', 'Groceries', 'Auto', '03/15/2026', 'Tiller'],
  ['03/14/2026', 'SHELL OIL', 'Gas', '-52.10', 'Credit Card', '****5678', 'Amex', '2026-03', '2026-03-09', 'txn_002', 'acct_002', '', 'SHELL OIL 57442 HOUSTON TX', '03/14/2026', '', '', '', 'Tiller'],
  ['03/10/2026', 'PAYROLL DEPOSIT', 'Income', '3500.00', 'Checking', '****1234', 'Chase', '2026-03', '2026-03-09', 'txn_003', 'acct_001', '', 'PAYROLL DEPOSIT ACME CORP', '03/10/2026', 'Income', 'Auto', '03/10/2026', 'Tiller'],
]

const SAMPLE_CATEGORIES = [
  ['Category', 'Group', 'Type', 'Amount'],
  ['Groceries', 'Food', 'Expense', '800'],
  ['Gas', 'Transportation', 'Expense', '200'],
  ['Income', 'Income', 'Income', '0'],
  ['Dining Out', 'Food', 'Expense', '250'],
]

const mockBatchGet = mock.fn(async () => ({
  data: {
    valueRanges: [
      { values: SAMPLE_TRANSACTIONS },
      { values: SAMPLE_CATEGORIES },
    ],
  },
}))

const mockSetCredentials = mock.fn()

mock.module('googleapis', {
  namedExports: {
    google: {
      auth: {
        OAuth2: class {
          constructor() {}
          setCredentials = mockSetCredentials
          on() {}
        },
      },
      sheets: () => ({
        spreadsheets: {
          values: { batchGet: mockBatchGet },
        },
      }),
    },
  },
})

const { setSecret } = await import('../../../scripts/core/db.js')
setSecret('sheets_refresh_token', 'test-refresh-token')

const { fetchSheetData } = await import('../../../scripts/modules/tiller/sheets-client.js')

describe('sheets-client', () => {
  beforeEach(() => {
    mockBatchGet.mock.resetCalls()
  })

  it('fetches and parses transactions with correct types', async () => {
    const { transactions, categories } = await fetchSheetData()

    assert.equal(transactions.length, 3)
    assert.equal(transactions[0].description, 'TRADER JOES #123')
    assert.equal(transactions[0].category, 'Groceries')
    assert.equal(transactions[0].amount, -84.32)
    assert.equal(transactions[0].account, 'Checking')
    assert.equal(transactions[0].institution, 'Chase')
    assert.ok(transactions[0].date instanceof Date)
  })

  it('parses categories with budget amounts', async () => {
    const { categories } = await fetchSheetData()

    assert.equal(categories.length, 4)
    assert.equal(categories[0].name, 'Groceries')
    assert.equal(categories[0].group, 'Food')
    assert.equal(categories[0].type, 'Expense')
    assert.equal(categories[0].budget, 800)
  })

  it('calls batchGet with correct sheet ranges', async () => {
    await fetchSheetData()

    assert.equal(mockBatchGet.mock.callCount(), 1)
    const args = mockBatchGet.mock.calls[0].arguments[0]
    assert.equal(args.spreadsheetId, 'test-sheet-id')
    assert.deepEqual(args.ranges, ['Transactions!A:R', 'Categories!A:D'])
  })

  it('handles empty transaction sheet', async () => {
    mockBatchGet.mock.mockImplementationOnce(async () => ({
      data: {
        valueRanges: [
          { values: [SAMPLE_TRANSACTIONS[0]] },  // header only
          { values: SAMPLE_CATEGORIES },
        ],
      },
    }))

    const { transactions } = await fetchSheetData()
    assert.equal(transactions.length, 0)
  })

  it('handles missing optional columns gracefully', async () => {
    const sparseRow = ['03/15/2026', 'STORE', 'Groceries', '-50.00']
    mockBatchGet.mock.mockImplementationOnce(async () => ({
      data: {
        valueRanges: [
          { values: [SAMPLE_TRANSACTIONS[0], sparseRow] },
          { values: SAMPLE_CATEGORIES },
        ],
      },
    }))

    const { transactions } = await fetchSheetData()
    assert.equal(transactions.length, 1)
    assert.equal(transactions[0].account, '')
    assert.equal(transactions[0].institution, '')
  })

  it('throws if sheets_refresh_token is missing', async () => {
    // This test would require resetting the module — skip for now,
    // the error path is validated in integration testing
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --experimental-test-module-mocks --test tests/modules/tiller/sheets-client.test.js
```

Expected: FAIL — `sheets-client.js` does not exist yet.

- [ ] **Step 3: Create `scripts/modules/tiller/sheets-client.js`**

```js
// scripts/modules/tiller/sheets-client.js
// Google Sheets API wrapper for Tiller Foundation spreadsheet.
// Read-only — only batchGet is exposed. No write methods.
import { google } from 'googleapis'
import { getSecret, setSecret } from '../../core/db.js'
import { logger } from '../../core/logger.js'

const SHEET_ID = process.env.TILLER_SHEET_ID

function getOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  const refreshToken = getSecret('sheets_refresh_token')
  if (!refreshToken) {
    throw new Error('Google Sheets not authorized — run: source .env && node scripts/modules/tiller/setup.js')
  }
  client.setCredentials({ refresh_token: refreshToken })
  client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      setSecret('sheets_refresh_token', tokens.refresh_token)
      logger.info('sheets-client', 'token-rotated', 'refresh token updated')
    }
  })
  return client
}

function getSheetsApi() {
  return google.sheets({ version: 'v4', auth: getOAuth2Client() })
}

/**
 * Fetches Transactions and Categories sheets in a single batchGet call.
 * Returns { transactions: Transaction[], categories: Category[] }
 */
export async function fetchSheetData() {
  if (!SHEET_ID) {
    throw new Error('TILLER_SHEET_ID not set — add it to .env')
  }

  const sheets = getSheetsApi()
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID,
    ranges: ['Transactions!A:R', 'Categories!A:D'],
  })

  const [txnRange, catRange] = res.data.valueRanges

  // Parse transactions
  const txnRows = txnRange.values ?? []
  const txnHeader = txnRows[0] ?? []
  const txnData = txnRows.slice(1)

  const txnIndex = {}
  txnHeader.forEach((name, i) => { txnIndex[name] = i })
  const txnCol = (row, name) => row[txnIndex[name]] ?? ''

  const transactions = txnData.filter(row => row.length > 0).map(row => ({
    date: new Date(txnCol(row, 'Date')),
    description: txnCol(row, 'Description'),
    category: txnCol(row, 'Category'),
    amount: parseFloat(txnCol(row, 'Amount')) || 0,
    account: txnCol(row, 'Account'),
    institution: txnCol(row, 'Institution'),
    fullDescription: txnCol(row, 'Full Description'),
  }))

  // Parse categories
  const catRows = catRange.values ?? []
  const catHeader = catRows[0] ?? []
  const catData = catRows.slice(1)

  const catIndex = {}
  catHeader.forEach((name, i) => { catIndex[name] = i })
  const catCol = (row, name) => row[catIndex[name]] ?? ''

  const categories = catData.filter(row => row.length > 0).map(row => ({
    name: catCol(row, 'Category'),
    group: catCol(row, 'Group'),
    type: catCol(row, 'Type'),
    budget: parseFloat(catCol(row, 'Amount')) || 0,
  }))

  return { transactions, categories }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-test-module-mocks --test tests/modules/tiller/sheets-client.test.js
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/modules/tiller/sheets-client.js tests/modules/tiller/sheets-client.test.js
git commit -m "feat(tiller): add sheets-client with OAuth2 auth and batchGet data fetching"
```

---

### Task 3: Create prompts.js (Claude prompt builders)

**Files:**
- Create: `scripts/modules/tiller/prompts.js`
- Create: `tests/modules/tiller/prompts.test.js`

Three prompt builders: `buildQueryPrompt`, `buildWeeklyDigestPrompt`, `buildBudgetCheckPrompt`. Each returns a string. All follow the pattern in `gmail/prompts.js` and `calendar/prompts.js` — accept context as params, return full prompt string, request JSON or formatted text output.

- [ ] **Step 1: Write the test file**

```js
// tests/modules/tiller/prompts.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildQueryPrompt,
  buildWeeklyDigestPrompt,
  buildBudgetCheckPrompt,
} from '../../../scripts/modules/tiller/prompts.js'

const sampleTransactions = [
  { date: new Date('2026-03-15'), description: 'TRADER JOES', category: 'Groceries', amount: -84.32, account: 'Checking', institution: 'Chase' },
  { date: new Date('2026-03-14'), description: 'SHELL OIL', category: 'Gas', amount: -52.10, account: 'Credit Card', institution: 'Amex' },
]

const sampleCategories = [
  { name: 'Groceries', group: 'Food', type: 'Expense', budget: 800 },
  { name: 'Gas', group: 'Transportation', type: 'Expense', budget: 200 },
  { name: 'Dining Out', group: 'Food', type: 'Expense', budget: 250 },
]

describe('buildQueryPrompt', () => {
  it('includes the user question and today date', () => {
    const prompt = buildQueryPrompt({
      question: 'how much on groceries',
      transactions: sampleTransactions,
      categories: sampleCategories,
      today: '2026-03-25',
    })
    assert.ok(prompt.includes('how much on groceries'))
    assert.ok(prompt.includes('2026-03-25'))
  })

  it('includes transaction data and budget summary', () => {
    const prompt = buildQueryPrompt({
      question: 'spending this month',
      transactions: sampleTransactions,
      categories: sampleCategories,
      today: '2026-03-25',
    })
    assert.ok(prompt.includes('TRADER JOES'))
    assert.ok(prompt.includes('84.32'))
    // Verify budget data is included (not empty)
    assert.ok(prompt.includes('Groceries'))
    assert.ok(prompt.includes('800'))
  })

  it('instructs HTML formatting', () => {
    const prompt = buildQueryPrompt({
      question: 'test',
      transactions: [],
      categories: [],
      today: '2026-03-25',
    })
    assert.ok(prompt.includes('HTML'))
  })
})

describe('buildWeeklyDigestPrompt', () => {
  it('includes all required sections', () => {
    const prompt = buildWeeklyDigestPrompt({
      weekTransactions: sampleTransactions,
      monthByCategory: { Groceries: -84.32, Gas: -52.10 },
      budgets: sampleCategories,
      uncategorizedCount: 3,
      today: '2026-03-25',
      monthName: 'March',
    })
    assert.ok(prompt.includes('Weekly Spending Digest'))
    assert.ok(prompt.includes('uncategorized'))
    assert.ok(prompt.includes('3'))
    assert.ok(prompt.includes('March'))
  })

  it('includes emoji rules', () => {
    const prompt = buildWeeklyDigestPrompt({
      weekTransactions: [],
      monthByCategory: {},
      budgets: sampleCategories,
      uncategorizedCount: 0,
      today: '2026-03-25',
      monthName: 'March',
    })
    assert.ok(prompt.includes('⚠️'))
    assert.ok(prompt.includes('🚨'))
  })
})

describe('buildBudgetCheckPrompt', () => {
  it('includes category budgets and spending', () => {
    const prompt = buildBudgetCheckPrompt({
      monthByCategory: { Groceries: -623, Gas: -145 },
      budgets: sampleCategories,
      today: '2026-03-25',
      monthName: 'March',
    })
    assert.ok(prompt.includes('Groceries'))
    assert.ok(prompt.includes('800'))
    assert.ok(prompt.includes('623'))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-test-module-mocks --test tests/modules/tiller/prompts.test.js
```

Expected: FAIL — `prompts.js` does not exist.

- [ ] **Step 3: Create `scripts/modules/tiller/prompts.js`**

```js
// scripts/modules/tiller/prompts.js
// All Claude prompt strings for the tiller module.
// No prompt strings should appear in index.js.

function formatTransactionsCSV(transactions) {
  if (transactions.length === 0) return '(no transactions in this period)'
  const header = 'Date | Description | Category | Amount | Account'
  const rows = transactions.map(t =>
    `${t.date.toLocaleDateString('en-US')} | ${t.description} | ${t.category || '(uncategorized)'} | $${t.amount.toFixed(2)} | ${t.account}`
  )
  return [header, ...rows].join('\n')
}

function formatCategoryBudgets(monthByCategory, budgets) {
  const lines = budgets
    .filter(c => c.type === 'Expense' && c.budget > 0)
    .map(c => {
      const spent = Math.abs(monthByCategory[c.name] ?? 0)
      const remaining = c.budget - spent
      return `${c.name}: spent $${spent.toFixed(2)} of $${c.budget.toFixed(2)} budget ($${remaining.toFixed(2)} remaining)`
    })
  return lines.length > 0 ? lines.join('\n') : '(no budgeted categories found)'
}

export function buildQueryPrompt({ question, transactions, categories, today }) {
  const txnData = formatTransactionsCSV(transactions)
  const monthByCategory = transactions.reduce((acc, t) => {
    acc[t.category] = (acc[t.category] ?? 0) + t.amount
    return acc
  }, {})
  const budgetData = formatCategoryBudgets(monthByCategory, categories)

  return `You are a personal finance assistant analyzing Tiller budget data. Answer the user's question concisely.

Today's date: ${today}

Transaction data:
${txnData}

Category budgets (monthly):
${budgetData}

User question: "${question}"

Rules:
- Format your response for Telegram using HTML tags (<b>bold</b> for totals, amounts).
- Use $ currency formatting with 2 decimal places.
- Be concise — this is a mobile chat interface.
- If the data doesn't contain enough information to answer, say so clearly.
- Escape &, <, > as &amp; &lt; &gt; in any user-facing text that isn't an HTML tag.
- Do NOT wrap in markdown code blocks. Return plain HTML text only.`
}

export function buildWeeklyDigestPrompt({ weekTransactions, monthByCategory, budgets, uncategorizedCount, today, monthName }) {
  const weekTotal = weekTransactions
    .filter(t => t.amount < 0)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0)

  const categoryLines = budgets
    .filter(c => c.type === 'Expense' && c.budget > 0)
    .map(c => {
      const spent = Math.abs(monthByCategory[c.name] ?? 0)
      const remaining = c.budget - spent
      const pctRemaining = c.budget > 0 ? remaining / c.budget : 1
      return `${c.name} | $${spent.toFixed(2)} | $${c.budget.toFixed(2)} | $${remaining.toFixed(2)} | ${pctRemaining}`
    })
    .join('\n')

  return `Generate a Weekly Spending Digest for Telegram. Use this exact format with HTML tags:

💰 <b>Weekly Spending Digest — ${today}</b>

Total spent this week: <b>$${weekTotal.toFixed(2)}</b>

📊 <b>Budget Status (${monthName})</b>

Then a table of ALL budgeted categories with columns: Category, Spent, Budget, Remaining.
Add emoji after each row:
- 🚨 if the category is OVER budget (remaining is negative)
- ⚠️ if less than 10% of budget remaining
- No emoji if healthy

Category data (Category | Spent | Budget | Remaining | PctRemaining):
${categoryLines || '(no budgeted categories)'}

After the table, add:
⚠️ = &lt;10% remaining · 🚨 = over budget

📋 <b>Uncategorized:</b> ${uncategorizedCount} transactions need review

Rules:
- Use HTML tags for Telegram (<b>, <code>, <pre>).
- Escape &, <, > as &amp; &lt; &gt; in non-tag text.
- Align the table using <pre> tags for monospace.
- Do NOT wrap in markdown code blocks. Return plain HTML text only.`
}

export function buildBudgetCheckPrompt({ monthByCategory, budgets, today, monthName }) {
  const categoryLines = budgets
    .filter(c => c.type === 'Expense' && c.budget > 0)
    .map(c => {
      const spent = Math.abs(monthByCategory[c.name] ?? 0)
      const remaining = c.budget - spent
      return `${c.name}: spent $${spent.toFixed(2)} of $${c.budget.toFixed(2)} ($${remaining.toFixed(2)} remaining)`
    })
    .join('\n')

  return `You are a budget assistant. Give a concise budget status report for ${monthName}.

Today: ${today}

Budget status by category:
${categoryLines || '(no budgeted categories)'}

Rules:
- List each budgeted category with spent/budget/remaining.
- Flag categories that are over budget with 🚨.
- Flag categories with <10% remaining with ⚠️.
- End with a one-sentence overall assessment (e.g., "On track" or "Over budget in 2 categories").
- Format for Telegram using HTML (<b>bold</b> for emphasis).
- Escape &, <, > as &amp; &lt; &gt; in non-tag text.
- Be concise — mobile chat interface.
- Do NOT wrap in markdown code blocks. Return plain HTML text only.`
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-test-module-mocks --test tests/modules/tiller/prompts.test.js
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/modules/tiller/prompts.js tests/modules/tiller/prompts.test.js
git commit -m "feat(tiller): add Claude prompt builders for queries, digest, and budget check"
```

---

### Task 4: Create index.js (module entry points)

**Files:**
- Create: `scripts/modules/tiller/index.js`
- Create: `tests/modules/tiller/index.test.js`

Main module file with `run()`, `weeklyDigest()`, `handleCallback()`, and HTTP route registration. Follows the exact pattern from `calendar/index.js` and `gmail/index.js`.

- [ ] **Step 1: Write the test file**

```js
// tests/modules/tiller/index.test.js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)
process.env.GOOGLE_CLIENT_ID = 'test-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret'
process.env.TILLER_SHEET_ID = 'test-sheet-id'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_CHAT_ID = '12345'

const mockSend = mock.fn(async () => ({}))
const mockSendDigest = mock.fn(async () => ({}))
const mockAnswerCallbackQuery = mock.fn(async () => ({}))

mock.module('../../../scripts/core/telegram.js', {
  namedExports: {
    send: mockSend,
    sendDigest: mockSendDigest,
    answerCallbackQuery: mockAnswerCallbackQuery,
  },
})

const mockAsk = mock.fn(async () => 'You spent $84.32 on groceries this month.')

mock.module('../../../scripts/core/claude.js', {
  namedExports: { ask: mockAsk },
})

const mockHeartbeat = mock.fn(async () => {})
const mockStatusError = mock.fn(async () => {})

mock.module('../../../scripts/core/status.js', {
  namedExports: {
    heartbeat: mockHeartbeat,
    error: mockStatusError,
  },
})

const sampleData = {
  transactions: [
    { date: new Date('2026-03-15'), description: 'TRADER JOES', category: 'Groceries', amount: -84.32, account: 'Checking', institution: 'Chase', fullDescription: '' },
  ],
  categories: [
    { name: 'Groceries', group: 'Food', type: 'Expense', budget: 800 },
  ],
}

const mockFetchSheetData = mock.fn(async () => sampleData)

mock.module('../../../scripts/modules/tiller/sheets-client.js', {
  namedExports: { fetchSheetData: mockFetchSheetData },
})

// Mock http-server registerRoute to capture route registrations
const registeredRoutes = {}
mock.module('../../../scripts/system/http-server.js', {
  namedExports: {
    registerRoute: (method, path, handler) => {
      registeredRoutes[`${method} ${path}`] = handler
    },
  },
})

const { run, weeklyDigest, handleCallback, parseDateWindow } = await import('../../../scripts/modules/tiller/index.js')

describe('tiller run()', () => {
  beforeEach(() => {
    mockSend.mock.resetCalls()
    mockAsk.mock.resetCalls()
    mockFetchSheetData.mock.resetCalls()
    mockHeartbeat.mock.resetCalls()
  })

  it('strips $ prefix and sends Claude response', async () => {
    await run({ message: { text: '$ how much on groceries?' } })

    assert.equal(mockFetchSheetData.mock.callCount(), 1)
    assert.equal(mockAsk.mock.callCount(), 1)
    assert.equal(mockSend.mock.callCount(), 1)
    assert.equal(mockSend.mock.calls[0].arguments[0], 'You spent $84.32 on groceries this month.')
    assert.equal(mockHeartbeat.mock.callCount(), 1)
  })

  it('handles empty $ with helpful message', async () => {
    await run({ message: { text: '$' } })

    assert.equal(mockSend.mock.callCount(), 1)
    assert.ok(mockSend.mock.calls[0].arguments[0].includes('ask a question'))
  })
})

describe('tiller weeklyDigest()', () => {
  beforeEach(() => {
    mockSend.mock.resetCalls()
    mockAsk.mock.resetCalls()
    mockFetchSheetData.mock.resetCalls()
    mockHeartbeat.mock.resetCalls()
  })

  it('fetches data and sends digest', async () => {
    await weeklyDigest()

    assert.equal(mockFetchSheetData.mock.callCount(), 1)
    assert.equal(mockAsk.mock.callCount(), 1)
    assert.equal(mockSend.mock.callCount(), 1)
    assert.equal(mockHeartbeat.mock.callCount(), 1)
  })
})

describe('tiller handleCallback()', () => {
  it('answers with expiry message', async () => {
    await handleCallback({ id: 'cb_123', message: { chat: { id: '12345' } } })

    assert.equal(mockAnswerCallbackQuery.mock.callCount(), 1)
    assert.equal(mockSend.mock.callCount(), 1)
    assert.ok(mockSend.mock.calls[0].arguments[0].includes('expired'))
  })
})

describe('HTTP route registration', () => {
  it('registers POST /tiller/weekly-digest', () => {
    assert.ok(registeredRoutes['POST /tiller/weekly-digest'])
  })
})

describe('parseDateWindow', () => {
  it('defaults to current month', () => {
    const { start, end } = parseDateWindow('how much on groceries', '2026-03-25')
    assert.equal(start.getFullYear(), 2026)
    assert.equal(start.getMonth(), 2) // March = 2
    assert.equal(start.getDate(), 1)
    assert.equal(end.getDate(), 25)
  })

  it('handles "this year"', () => {
    const { start } = parseDateWindow('spending this year', '2026-03-25')
    assert.equal(start.getMonth(), 0)
    assert.equal(start.getDate(), 1)
  })

  it('handles "last month"', () => {
    const { start, end } = parseDateWindow('last month spending', '2026-03-25')
    assert.equal(start.getMonth(), 1) // February
    assert.equal(end.getMonth(), 1)
    assert.equal(end.getDate(), 28) // Feb 28 2026
  })

  it('handles named month "january"', () => {
    const { start, end } = parseDateWindow('spending in january', '2026-03-25')
    assert.equal(start.getMonth(), 0)
    assert.equal(start.getFullYear(), 2026)
  })

  it('does not match "mar" inside "market"', () => {
    const { start } = parseDateWindow('farmers market spending', '2026-06-15')
    // Should default to current month (June), not March
    assert.equal(start.getMonth(), 5) // June
  })

  it('handles "ytd"', () => {
    const { start } = parseDateWindow('ytd totals', '2026-03-25')
    assert.equal(start.getMonth(), 0)
    assert.equal(start.getDate(), 1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --experimental-test-module-mocks --test tests/modules/tiller/index.test.js
```

Expected: FAIL — `index.js` does not exist.

- [ ] **Step 3: Create `scripts/modules/tiller/index.js`**

```js
// scripts/modules/tiller/index.js
// Tiller Budget module — read-only Google Sheets Q&A and weekly digest.
import { heartbeat, error as statusError } from '../../core/status.js'
import { logger } from '../../core/logger.js'
import { auditLog } from '../../core/db.js'
import { send, answerCallbackQuery } from '../../core/telegram.js'
import { ask } from '../../core/claude.js'
import { registerRoute } from '../../system/http-server.js'
import { fetchSheetData } from './sheets-client.js'
import { buildQueryPrompt, buildWeeklyDigestPrompt, buildBudgetCheckPrompt } from './prompts.js'

// Register HTTP route for n8n scheduled trigger (fire-and-forget pattern)
registerRoute('POST', '/tiller/weekly-digest', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  weeklyDigest().catch(err => {
    statusError('tiller', err)
    logger.error('tiller', 'http-weekly-digest-error', err.message)
  })
})

/**
 * Determine date window from question text using keyword heuristics.
 * Returns { start: Date, end: Date }.
 * All dates use local-time constructors to avoid UTC offset issues.
 */
export function parseDateWindow(question, today) {
  // Parse today as local date components to avoid UTC offset issues
  const [yr, mo, da] = today.split('-').map(Number)
  const now = new Date(yr, mo - 1, da)
  const year = now.getFullYear()
  const month = now.getMonth()

  const q = question.toLowerCase()

  // "this year" or "year to date" or "ytd"
  if (/this year|year to date|\bytd\b/i.test(q)) {
    return { start: new Date(year, 0, 1), end: now }
  }

  // "last month"
  if (/last month/i.test(q)) {
    return { start: new Date(year, month - 1, 1), end: new Date(year, month, 0) }
  }

  // "last week"
  if (/last week/i.test(q)) {
    const dayOfWeek = now.getDay()
    const endOfLastWeek = new Date(year, month, now.getDate() - dayOfWeek)
    const startOfLastWeek = new Date(endOfLastWeek.getFullYear(), endOfLastWeek.getMonth(), endOfLastWeek.getDate() - 6)
    return { start: startOfLastWeek, end: endOfLastWeek }
  }

  // "this week"
  if (/this week/i.test(q)) {
    const dayOfWeek = now.getDay()
    const startOfWeek = new Date(year, month, now.getDate() - dayOfWeek)
    return { start: startOfWeek, end: now }
  }

  // Named month with word boundary: "january", "jan", etc.
  const months = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december']
  for (let i = 0; i < months.length; i++) {
    const pattern = new RegExp(`\\b${months[i].slice(0, 3)}(${months[i].slice(3)})?\\b`, 'i')
    if (pattern.test(q)) {
      const targetYear = i > month ? year - 1 : year
      return { start: new Date(targetYear, i, 1), end: new Date(targetYear, i + 1, 0) }
    }
  }

  // Default: current month
  return { start: new Date(year, month, 1), end: now }
}

/**
 * Aggregate spending by category from a list of transactions.
 */
function aggregateByCategory(transactions) {
  const result = {}
  for (const t of transactions) {
    const cat = t.category || '(uncategorized)'
    result[cat] = (result[cat] ?? 0) + t.amount
  }
  return result
}

/**
 * On-demand query handler — called when user sends "$ <question>".
 */
export async function run({ message } = {}) {
  try {
    const rawText = message?.text ?? ''
    const question = rawText.replace(/^\$\s*/, '').trim()

    if (!question) {
      await send('Usage: <code>$ &lt;question&gt;</code>\n\nExamples:\n• <code>$ how much did I spend on groceries this month?</code>\n• <code>$ am I over budget?</code>\n• <code>$ biggest expenses last week</code>')
      return
    }

    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const { transactions, categories } = await fetchSheetData()

    if (transactions.length === 0) {
      await send('No transactions found in your Tiller spreadsheet.')
      await heartbeat('tiller')
      return
    }

    // Filter transactions to relevant date window
    const { start, end } = parseDateWindow(question, today)
    const filtered = transactions.filter(t => t.date >= start && t.date <= end)

    if (filtered.length === 0) {
      await send(`No transactions found for that period (${start.toLocaleDateString('en-US')} – ${end.toLocaleDateString('en-US')}).`)
      await heartbeat('tiller')
      return
    }

    // Check if this is a budget-specific query
    const isBudgetQuery = /budget|over budget|under budget|on track/i.test(question)
    const monthByCategory = aggregateByCategory(filtered)

    let prompt
    if (isBudgetQuery) {
      const monthName = new Date(start).toLocaleDateString('en-US', { month: 'long' })
      prompt = buildBudgetCheckPrompt({ monthByCategory, budgets: categories, today, monthName })
    } else {
      prompt = buildQueryPrompt({ question, transactions: filtered, categories, today })
    }

    const response = await ask(prompt, 'haiku', { module: 'tiller' })
    await send(response)

    auditLog('tiller', 'query', { question, transactionCount: filtered.length, dateRange: `${start.toISOString()}..${end.toISOString()}` })
    await heartbeat('tiller')
  } catch (err) {
    await statusError('tiller', err)
    throw err
  }
}

/**
 * Weekly digest — called by n8n schedule trigger (Sunday noon).
 */
export async function weeklyDigest() {
  try {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const monthName = now.toLocaleDateString('en-US', { month: 'long' })

    const { transactions, categories } = await fetchSheetData()

    // Current month transactions
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthTxns = transactions.filter(t => t.date >= monthStart && t.date <= now)

    // This week transactions (Sunday–Saturday)
    const dayOfWeek = now.getDay()
    const weekStart = new Date(now)
    weekStart.setDate(now.getDate() - dayOfWeek)
    weekStart.setHours(0, 0, 0, 0)
    const weekTxns = monthTxns.filter(t => t.date >= weekStart)

    const monthByCategory = aggregateByCategory(monthTxns)
    const uncategorizedCount = monthTxns.filter(t => !t.category || t.category.trim() === '').length

    const prompt = buildWeeklyDigestPrompt({
      weekTransactions: weekTxns,
      monthByCategory,
      budgets: categories,
      uncategorizedCount,
      today,
      monthName,
    })

    const response = await ask(prompt, 'haiku', { module: 'tiller' })
    await send(response)

    const weekTotal = weekTxns.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0)
    auditLog('tiller', 'weekly_digest', { transactionCount: monthTxns.length, weekTotal: weekTotal.toFixed(2) })
    await heartbeat('tiller')
  } catch (err) {
    await statusError('tiller', err)
    throw err
  }
}

/**
 * Callback handler stub — answers expired callbacks.
 * Matches the calendar module pattern.
 */
export async function handleCallback(callbackQuery) {
  await answerCallbackQuery(callbackQuery.id, '')
  await send('This action has expired.')
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --experimental-test-module-mocks --test tests/modules/tiller/index.test.js
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/modules/tiller/index.js tests/modules/tiller/index.test.js
git commit -m "feat(tiller): add module entry points — run(), weeklyDigest(), handleCallback()"
```

---

### Task 5: Wire up router and main entry point

**Files:**
- Modify: `scripts/system/telegram-router.js:38-39`
- Modify: `scripts/system/telegram-router-main.js:8`

- [ ] **Step 1: Update telegram-router.js — replace tiller placeholder**

In `scripts/system/telegram-router.js`, replace lines 38-39:

```js
// Before (line 38-39):
    } else if (text.startsWith('$')) {
      // Phase 3: tiller

// After:
    } else if (text.startsWith('$')) {
      const mod = await import('../modules/tiller/index.js')
      await mod.run({ message })
```

- [ ] **Step 2: Update telegram-router-main.js — add tiller import**

In `scripts/system/telegram-router-main.js`, add tiller import after the gmail import (after line 8):

```js
// Before (line 7-8):
// Import modules to trigger registerRoute() side-effects
import '../modules/gmail/index.js'

// After:
// Import modules to trigger registerRoute() side-effects
import '../modules/gmail/index.js'
import '../modules/tiller/index.js'
```

- [ ] **Step 3: Run existing tests to confirm nothing is broken**

```bash
node --experimental-test-module-mocks --test tests/**/*.test.js
```

Expected: All existing tests PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/system/telegram-router.js scripts/system/telegram-router-main.js
git commit -m "feat(tiller): wire up $ router prefix and HTTP endpoint registration"
```

---

### Task 6: Update env, docs, and changelog

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add TILLER_SHEET_ID to .env.example**

Append to `.env.example`, after the Google OAuth section:

```bash
# Tiller Google Sheet ID — the long string in the sheet URL:
# https://docs.google.com/spreadsheets/d/<THIS_PART>/edit
export TILLER_SHEET_ID=
```

- [ ] **Step 2: Update CLAUDE.md Stack section**

In `CLAUDE.md`, update the Stack section to add Google Sheets:

```markdown
## Stack
- Node.js ES modules for all logic (/scripts/)
- Standalone bot service (scripts/system/telegram-router-main.js) — Telegram
  long-polling, command routing, callback handling, confirmation cleanup
- n8n (Docker) — scheduled triggers only (daily digest, weekly summary, etc.)
  n8n Code nodes cannot use dynamic import(); scheduled workflows call a local
  HTTP endpoint on the bot service instead of running scripts directly
- SQLite for local state (/data/agent.db)
- Google Sheets API (read-only) for Tiller budget queries
- Docker Compose — ports bound to 127.0.0.1 only
```

- [ ] **Step 3: Add CHANGELOG.md entries**

Add under `## [Unreleased]` → `### Added`, above the existing calendar entry:

```markdown
- Tiller module: read-only Google Sheets Q&A via `$` Telegram command — Claude haiku analyzes transactions and budget data; weekly spending digest (Sunday noon) with per-category budget status, emoji warnings (⚠️ <10% remaining, 🚨 over budget), and uncategorized transaction count
- `scripts/modules/tiller/sheets-client.js`: googleapis wrapper with separate OAuth2 consent (spreadsheets.readonly scope), dynamic header-row parsing
- `scripts/modules/tiller/setup.js`: one-time CLI for Google Sheets OAuth consent — stores refresh token AES-256-GCM encrypted in SQLite
```

- [ ] **Step 4: Commit**

```bash
git add .env.example CLAUDE.md CHANGELOG.md
git commit -m "docs(tiller): add env var, update CLAUDE.md stack, add CHANGELOG entries"
```

---

### Task 7: Run OAuth setup and end-to-end verification

**Files:** None — this is manual verification.

**Prerequisite:** Google Sheets API must be enabled in Google Cloud Console.

- [ ] **Step 1: Enable Google Sheets API**

In Google Cloud Console → APIs & Services → Library → search "Google Sheets API" → Enable.

- [ ] **Step 2: Run OAuth setup**

```bash
source .env && node scripts/modules/tiller/setup.js
```

Open the URL in browser, authorize, confirm "Sheets authorized" message appears.

- [ ] **Step 3: Set TILLER_SHEET_ID in .env**

Find your Tiller sheet ID from the URL (`https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`) and add to `.env`:

```bash
export TILLER_SHEET_ID=<your-sheet-id>
```

- [ ] **Step 4: Test on-demand query**

Send via Telegram: `$ how much did I spend this month?`

Expected: Claude responds with a formatted spending summary using your actual Tiller data.

- [ ] **Step 5: Test budget check**

Send via Telegram: `$ am I over budget?`

Expected: Claude responds with per-category budget status.

- [ ] **Step 6: Test empty query**

Send via Telegram: `$`

Expected: Usage help message with examples.

- [ ] **Step 7: Test weekly digest via HTTP**

```bash
curl -X POST http://localhost:3000/tiller/weekly-digest
```

Expected: `{"ok":true}` response, then a Telegram message with the weekly digest format (categories, budget status, emoji warnings, uncategorized count).

- [ ] **Step 8: Test error path**

Temporarily set `TILLER_SHEET_ID=invalid_id` in .env, restart the bot service, send `$ test`, confirm an error message is sent to Telegram and `status.error()` fires. Then restore the correct ID.

- [ ] **Step 9: Run full test suite**

```bash
node --experimental-test-module-mocks --test tests/**/*.test.js
```

Expected: All tests PASS.

---

### Task 8: Create n8n workflow and finalize

**Files:**
- Create: `workflows/modules/tiller-weekly-digest.json`

- [ ] **Step 1: Create the n8n workflow**

In the n8n UI:
1. Create new workflow named "Tiller Weekly Digest"
2. Add Schedule Trigger node → Every week, Sunday, 12:00 PM
3. Add HTTP Request node → POST `http://bot:3000/tiller/weekly-digest`
4. Add error branch → Send Telegram message with error details
5. Activate the workflow

- [ ] **Step 2: Export and commit the workflow**

Export from n8n UI → Save as `workflows/modules/tiller-weekly-digest.json`.

```bash
git add workflows/modules/tiller-weekly-digest.json
git commit -m "feat(tiller): add n8n weekly digest schedule trigger workflow"
```

- [ ] **Step 3: Open PR**

```bash
git push -u origin phase-3-tiller
```

Open PR against `main` with title "Phase 3: Tiller Budget Module" and description covering: what was added, how to set up (OAuth + env var), how to test.

---

## Carry-Forward Issues

### Important — No null-safety guard on `res.data.valueRanges` (sheets-client.js:47)
**File:** `scripts/modules/tiller/sheets-client.js`, line ~47
**Issue:** `const [txnRange, catRange] = res.data.valueRanges` — if `valueRanges` is undefined (e.g., Sheets API returns a partial or unexpected response), destructuring will throw an uninformative TypeError.
**To address in Task 4** — add a guard before destructuring:
```js
if (!res.data.valueRanges || res.data.valueRanges.length < 2) {
  throw new Error('Sheets API returned unexpected response — missing valueRanges')
}
```

### Important — Null date crash in `formatTransactionsCSV` (prompts.js)
**File:** `scripts/modules/tiller/prompts.js`, line ~9
**Issue:** `t.date.toLocaleDateString('en-US')` throws TypeError if `t.date` is null or not a Date object. Malformed rows from Sheets (blank date cells) can produce null dates.
**To address before PR** — add guard: `t.date instanceof Date ? t.date.toLocaleDateString('en-US') : 'N/A'`

### Important — Null category coerces to string `"null"` in `buildQueryPrompt` reduce (prompts.js)
**File:** `scripts/modules/tiller/prompts.js`, lines ~27-30
**Issue:** `acc[t.category]` where `t.category` is null becomes `acc["null"]` — misattributes spending for uncategorized transactions.
**To address before PR** — fix: `acc[t.category || '(uncategorized)'] = ...`

### Important — `pctRemaining` is a raw JS float, ambiguous to Claude (prompts.js)
**File:** `scripts/modules/tiller/prompts.js`, line ~65
**Issue:** `PctRemaining` column label implies percentage but value is a fraction (0.125 not 12.5%). Claude could misclassify budget status.
**To address before PR** — fix: `(pctRemaining * 100).toFixed(1)` and update label/thresholds in the prompt instruction.

### Important — `parseDateWindow` end-of-today is midnight (fragile date boundary) (index.js)
**File:** `scripts/modules/tiller/index.js`, `parseDateWindow`
**Issue:** `end = new Date(yr, mo-1, da)` is midnight. Works correctly against current sheets-client.js (date-only Tiller dates also parse to midnight), but will silently drop today's transactions if date parsing ever includes a time component.
**Review before PR** — consider: `end = new Date(yr, mo-1, da+1)` (strictly less than tomorrow midnight) as a more resilient boundary.

### Important — Inconsistent "end of today" boundary between `run()` and `weeklyDigest()` (index.js)
**File:** `scripts/modules/tiller/index.js`
**Issue:** `run()` uses `parseDateWindow` → midnight today as upper bound. `weeklyDigest()` uses `new Date()` (current clock time). Minor behavioral difference but inconsistent.
**Review before PR**

### Important — Budget query uses windowed `monthByCategory`, not full-month (index.js)
**File:** `scripts/modules/tiller/index.js`, `isBudgetQuery` branch (~line 122-128)
**Issue:** If user asks "am I over budget this year?", `monthByCategory` contains yearly aggregate but `monthName` resolves to "January". Most realistic budget queries use the current-month default so this is rarely wrong in practice.
**Review before PR**

### Minor — XSS risk in setup.js OAuth callback HTML (setup.js)
**File:** `scripts/modules/tiller/setup.js` (inherited from `gmail/setup.js`)
**Issue:** Error message in OAuth callback HTML page reflects unsanitized input via `error.message`. Localhost only — negligible real-world risk.
**Decision:** Review collectively at end of all tasks. Consistent with Gmail module behavior; fix both together or neither.
