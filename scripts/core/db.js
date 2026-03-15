// scripts/core/db.js
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _db = null

export function getDb() {
  if (_db) return _db
  const dbPath = process.env.DB_PATH || ':memory:'
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  // Only exec schema if tables don't exist yet — avoids redundant DDL on warm file DBs.
  // For :memory: DBs (tests), tables never pre-exist so schema always runs.
  // Sentinel: module_status is the first table defined in schema.sql. If it exists,
  // we assume all other tables do too. A partially-initialised DB would need manual
  // re-initialisation via `npm run db:init` (which uses CREATE TABLE IF NOT EXISTS).
  const tableExists = _db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='module_status'").get()
  if (!tableExists) {
    const schema = readFileSync(join(__dirname, '../db/schema.sql'), 'utf8')
    _db.exec(schema)
  }
  return _db
}

export function closeDb() {
  if (_db) {
    _db.close()
    _db = null
  }
}

export function auditLog(module, action, metadata = {}, success = 1) {
  getDb().prepare(
    'INSERT INTO audit_log (ts, module, action, detail, success) VALUES (?, ?, ?, ?, ?)'
  ).run(Date.now(), module, action, JSON.stringify(metadata), success)
}

export function getPreference(key) {
  const row = getDb().prepare('SELECT value FROM preferences WHERE key = ?').get(key)
  return row ? row.value : null
}

export function setPreference(key, value) {
  getDb().prepare(
    'INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value))
}

// IMPORTANT: params must always be an array, e.g. query('SELECT ...', ['value']).
// Passing a scalar (string, number) will silently misbind in better-sqlite3.
export function query(sql, params = []) {
  return getDb().prepare(sql).all(params)
}

export function queryOne(sql, params = []) {
  return getDb().prepare(sql).get(params)
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(params)
}

export function checkBatchSize(items, cap = 50) {
  if (!Array.isArray(items)) throw new Error('checkBatchSize: items must be an array')
  if (items.length > cap) throw new Error(`Batch size ${items.length} exceeds cap of ${cap}`)
  return items.length > 20
}
