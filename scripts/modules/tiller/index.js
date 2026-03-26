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
      await send('Usage: <code>$ &lt;question&gt;</code> — ask a question about your spending.\n\nExamples:\n• <code>$ how much did I spend on groceries this month?</code>\n• <code>$ am I over budget?</code>\n• <code>$ biggest expenses last week</code>')
      await heartbeat('tiller')
      return
    }

    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const { transactions, categories } = await fetchSheetData()

    if (transactions.length === 0) {
      await send('No transactions found in your Tiller spreadsheet.')
      auditLog('tiller', 'query', { question, result: 'no_data' })
      await heartbeat('tiller')
      return
    }

    // Filter transactions to relevant date window
    const { start, end } = parseDateWindow(question, today)
    const filtered = transactions.filter(t => t.date >= start && t.date <= end)

    if (filtered.length === 0) {
      await send(`No transactions found for that period (${start.toLocaleDateString('en-US')} – ${end.toLocaleDateString('en-US')}).`)
      auditLog('tiller', 'query', { question, result: 'no_data_in_range' })
      await heartbeat('tiller')
      return
    }

    // Check if this is a budget-specific query
    const isBudgetQuery = /budget|on track/i.test(question)
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

    if (monthTxns.length === 0) {
      await send('No transactions found for this month yet.')
      await heartbeat('tiller')
      return
    }

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
