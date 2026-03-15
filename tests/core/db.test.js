// tests/core/db.test.js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Use in-memory DB for all tests
process.env.DB_PATH = ':memory:'

const { getDb, auditLog, getPreference, setPreference, query, queryOne, run, checkBatchSize } = await import('../../scripts/core/db.js')

// Clean all tables before each test to prevent cross-test contamination
beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM audit_log; DELETE FROM preferences; DELETE FROM module_status; DELETE FROM error_log; DELETE FROM token_log; DELETE FROM pending_confirmations')
})

describe('db.js', () => {
  describe('auditLog', () => {
    it('inserts a row into audit_log', () => {
      auditLog('test-module', 'test-action', { id: 1 })
      const rows = query('SELECT * FROM audit_log WHERE module = ?', ['test-module'])
      assert.equal(rows.length, 1)
      assert.equal(rows[0].action, 'test-action')
      assert.equal(rows[0].success, 1)
    })

    it('stores metadata as JSON string', () => {
      auditLog('test-module', 'action2', { key: 'value' })
      const row = queryOne('SELECT detail FROM audit_log WHERE action = ?', ['action2'])
      assert.equal(JSON.parse(row.detail).key, 'value')
    })
  })

  describe('preferences', () => {
    it('sets and gets a preference', () => {
      setPreference('test-key', 'test-value')
      assert.equal(getPreference('test-key'), 'test-value')
    })

    it('returns null for missing key', () => {
      assert.equal(getPreference('nonexistent'), null)
    })

    it('overwrites existing preference', () => {
      setPreference('overwrite-key', 'first')
      setPreference('overwrite-key', 'second')
      assert.equal(getPreference('overwrite-key'), 'second')
    })
  })

  describe('checkBatchSize', () => {
    it('returns false for items under or equal to 20', () => {
      assert.equal(checkBatchSize(new Array(10)), false)
      assert.equal(checkBatchSize(new Array(20)), false)
    })

    it('returns true for items over 20 (needs secondary confirm)', () => {
      const result = checkBatchSize(new Array(21))
      assert.equal(result, true)
    })

    it('throws for items over 50', () => {
      assert.throws(
        () => checkBatchSize(new Array(51)),
        /exceeds cap of 50/
      )
    })

    it('throws for non-array input', () => {
      assert.throws(
        () => checkBatchSize('not-an-array'),
        /must be an array/
      )
    })

    it('respects custom cap', () => {
      assert.throws(
        () => checkBatchSize(new Array(11), 10),
        /exceeds cap of 10/
      )
    })
  })
})
