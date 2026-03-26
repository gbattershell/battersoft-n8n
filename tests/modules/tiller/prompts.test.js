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
    assert.ok(prompt.includes('Uncategorized'))
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
