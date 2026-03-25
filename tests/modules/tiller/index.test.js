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
    { date: new Date(2026, 2, 15), description: 'TRADER JOES', category: 'Groceries', amount: -84.32, account: 'Checking', institution: 'Chase', fullDescription: '' },
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
  beforeEach(() => {
    mockSend.mock.resetCalls()
    mockAnswerCallbackQuery.mock.resetCalls()
  })

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
