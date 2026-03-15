// tests/core/claude.test.js
// Mocks the Anthropic SDK — no real API calls made.
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ANTHROPIC_API_KEY = 'test-key'

// Mock Anthropic SDK before importing claude.js
const mockCreate = async ({ model, messages }) => ({
  content: [{ text: `mocked response for ${model}` }],
  usage: { input_tokens: 10, output_tokens: 5 },
})

// Patch the SDK using module mock
mock.module('@anthropic-ai/sdk', {
  namedExports: {},
  defaultExport: class MockAnthropic {
    constructor() { this.messages = { create: mockCreate } }
  },
})

const { ask } = await import('../../scripts/core/claude.js')
const { query } = await import('../../scripts/core/db.js')

describe('claude.js', () => {
  it('returns text from the model response', async () => {
    const result = await ask('Hello', 'haiku', { module: 'test' })
    assert.match(result, /mocked response/)
  })

  it('uses haiku model by default', async () => {
    const result = await ask('test')
    assert.match(result, /claude-haiku-4-5-20251001/)
  })

  it('uses sonnet model when specified', async () => {
    const result = await ask('test', 'sonnet')
    assert.match(result, /claude-sonnet-4-6/)
  })

  it('throws on unknown model name', async () => {
    await assert.rejects(
      () => ask('test', 'gpt-4'),
      /Unknown model/
    )
  })

  it('logs token usage to token_log table', async () => {
    await ask('Hello', 'haiku', { module: 'test-log' })
    const rows = query('SELECT * FROM token_log WHERE module = ?', ['test-log'])
    assert.ok(rows.length > 0)
    assert.equal(rows[0].input_tokens, 10)
    assert.equal(rows[0].output_tokens, 5)
  })

  it('does not log prompt content', async () => {
    const sensitivePrompt = 'SECRET_PHRASE_DO_NOT_LOG'
    await ask(sensitivePrompt, 'haiku', { module: 'privacy-test' })
    const rows = query("SELECT * FROM token_log WHERE module = 'privacy-test'")
    for (const row of rows) {
      assert.ok(!JSON.stringify(row).includes('SECRET_PHRASE_DO_NOT_LOG'))
    }
  })

  it('deletes token_log rows older than 30 days on each call', async () => {
    const { run: dbRun } = await import('../../scripts/core/db.js')
    // Insert a row with ts 31 days ago
    const old = Math.floor(Date.now() / 1000) - 31 * 86400
    dbRun('INSERT INTO token_log (ts, module, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
      [old, 'old-module', 'claude-haiku-4-5-20251001', 5, 5])
    // Confirm it exists
    assert.equal(query('SELECT * FROM token_log WHERE module = ?', ['old-module']).length, 1)
    // Trigger cleanup via ask()
    await ask('hello', 'haiku', { module: 'cleanup-trigger' })
    // Old row should be gone
    assert.equal(query('SELECT * FROM token_log WHERE module = ?', ['old-module']).length, 0)
  })
})
