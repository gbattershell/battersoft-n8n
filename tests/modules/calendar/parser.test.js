import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)
process.env.ANTHROPIC_API_KEY = 'test-key'

const mockAsk = mock.fn(async () => '{}')
mock.module('../../../scripts/core/claude.js', {
  namedExports: { ask: mockAsk },
})

// Mock db.js for parser — it queries calendar_mapping
mock.module('../../../scripts/core/db.js', {
  namedExports: {
    query: mock.fn(() => [{ display_label: 'Garrett' }, { display_label: 'Kelsey' }]),
    getPreference: mock.fn(() => 'America/Chicago'),
    run: mock.fn(() => {}),
    auditLog: mock.fn(() => {}),
    getSecret: mock.fn(() => null),
    setSecret: mock.fn(() => {}),
    setPreference: mock.fn(() => {}),
    queryOne: mock.fn(() => null),
    getDb: mock.fn(() => ({})),
  },
})

const { parse } = await import('../../../scripts/modules/calendar/parser.js')

beforeEach(() => {
  mockAsk.mock.resetCalls()
})

describe('parser.js — parse()', () => {
  it('calls ask() with haiku model and calendar module option', async () => {
    mockAsk.mock.mockImplementationOnce(async () => '{"intent":"create","title":"Dentist","calendar":"Garrett","start":"2026-03-21T15:00:00","duration":60,"confidence":"high"}')
    await parse('add dentist Friday 3pm')
    assert.equal(mockAsk.mock.calls.length, 1)
    const [, model, opts] = mockAsk.mock.calls[0].arguments
    assert.equal(model, 'haiku')
    assert.deepEqual(opts, { module: 'calendar' })
  })

  it('returns parsed object when Claude returns valid JSON', async () => {
    const expected = { intent: 'create', title: 'Dentist', calendar: 'Garrett', start: '2026-03-21T15:00:00', duration: 60, confidence: 'high' }
    mockAsk.mock.mockImplementationOnce(async () => JSON.stringify(expected))
    const result = await parse('add dentist Friday 3pm')
    assert.deepEqual(result, expected)
  })

  it('returns { intent: "unknown", confidence: "low" } when Claude returns invalid JSON', async () => {
    mockAsk.mock.mockImplementationOnce(async () => 'not json')
    const result = await parse('add dentist Friday 3pm')
    assert.deepEqual(result, { intent: 'unknown', confidence: 'low' })
  })

  it('extracts and parses JSON from markdown-wrapped response', async () => {
    const inner = { intent: 'create', title: 'Dentist', calendar: 'Garrett', start: '2026-03-21T15:00:00', duration: 60, confidence: 'high' }
    mockAsk.mock.mockImplementationOnce(async () => `\`\`\`json\n${JSON.stringify(inner)}\n\`\`\``)
    const result = await parse('add dentist Friday 3pm')
    assert.deepEqual(result, inner)
  })

  it('includes existingEvent context in prompt for update commands', async () => {
    const existingEvent = { title: 'Dentist', start: '2026-03-21T15:00:00', calendar: 'Garrett' }
    mockAsk.mock.mockImplementationOnce(async () => '{"intent":"update","changes":{"start":"2026-03-21T16:00:00"},"confidence":"high"}')
    await parse('move to 4pm', { existingEvent })
    assert.equal(mockAsk.mock.calls.length, 1)
    const [prompt] = mockAsk.mock.calls[0].arguments
    assert.ok(prompt.includes(JSON.stringify(existingEvent)), 'prompt should include the existing event JSON')
    assert.ok(prompt.includes('update'), 'prompt should mention update intent')
  })
})
