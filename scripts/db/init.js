// scripts/db/init.js
// Run once to initialize the SQLite database: node scripts/db/init.js
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.DB_PATH

if (!dbPath) {
  console.error('DB_PATH environment variable is not set.')
  process.exit(1)
}

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
db.exec(schema)
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name).join(', ')
db.close()

console.log(`Database initialized at ${dbPath}`)
console.log('Tables:', tables)
