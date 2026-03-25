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

  it('throws informative error when TILLER_SHEET_ID is not set', async () => {
    const originalSheetId = process.env.TILLER_SHEET_ID
    delete process.env.TILLER_SHEET_ID
    try {
      await assert.rejects(
        () => fetchSheetData(),
        { message: 'TILLER_SHEET_ID not set — add it to .env' }
      )
    } finally {
      process.env.TILLER_SHEET_ID = originalSheetId
    }
  })
})
