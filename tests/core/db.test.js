// tests/core/db.test.js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Use in-memory DB for all tests
process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64) // 32 bytes as hex — test value only

const { getDb, closeDb, auditLog, getPreference, setPreference, query, queryOne, run, checkBatchSize, setSecret, getSecret } = await import('../../scripts/core/db.js')

// Clean all tables before each test to prevent cross-test contamination
beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM audit_log; DELETE FROM preferences; DELETE FROM module_status; DELETE FROM error_log; DELETE FROM token_log; DELETE FROM pending_confirmations')
})

describe('db.js', () => {
  describe('closeDb', () => {
    it('closes and resets the singleton so the next getDb() call re-initialises', () => {
      const db1 = getDb()
      closeDb()
      // getDb() here re-opens the singleton — intentional, ensures subsequent tests
      // share a live connection rather than hitting a closed-DB error.
      const db2 = getDb()
      assert.notEqual(db1, db2)
    })

    it('is a no-op when called on an already-closed or never-opened singleton', () => {
      closeDb() // close whatever is open
      assert.doesNotThrow(() => closeDb()) // second call must not throw
      getDb() // re-open for subsequent tests
    })
  })

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

    it('stores success=0 when explicitly passed', () => {
      auditLog('test-module', 'failed-action', { id: 2 }, 0)
      const row = queryOne('SELECT success FROM audit_log WHERE action = ?', ['failed-action'])
      assert.equal(row.success, 0)
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
})
