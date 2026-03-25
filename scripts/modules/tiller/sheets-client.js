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
