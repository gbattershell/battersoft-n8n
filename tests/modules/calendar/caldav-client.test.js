// tests/modules/calendar/caldav-client.test.js
import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)

const mockLogin = mock.fn(async () => {})
const mockFetchCalendars = mock.fn(async () => [
  { displayName: 'Garrett', url: '/cal/garrett/', props: {} },
  { displayName: 'Kelsey', url: '/cal/kelsey/', props: {} },
])
const mockFetchCalendarObjects = mock.fn(async () => [])
const mockCreateCalendarObject = mock.fn(async () => ({}))
const mockUpdateCalendarObject = mock.fn(async () => ({}))
const mockDeleteCalendarObject = mock.fn(async () => ({}))

mock.module('tsdav', {
  namedExports: {
    DAVClient: class MockDAVClient {
      constructor() {}
      login = mockLogin
      fetchCalendars = mockFetchCalendars
      fetchCalendarObjects = mockFetchCalendarObjects
      createCalendarObject = mockCreateCalendarObject
      updateCalendarObject = mockUpdateCalendarObject
      deleteCalendarObject = mockDeleteCalendarObject
    },
  },
})

// Mock ical.js — will be expanded in Task 3
mock.module('ical.js', {
  defaultExport: {
    parse: mock.fn(() => ({})),
    Component: class MockComponent {
      constructor() { this.jCal = ['vcalendar', [], []] }
      getAllSubcomponents() { return [] }
    },
  },
})

const { listCalendars, clearClient } = await import('../../../scripts/modules/calendar/caldav-client.js')
const { setSecret, getDb } = await import('../../../scripts/core/db.js')

beforeEach(() => {
  mockLogin.mock.resetCalls()
  mockFetchCalendars.mock.resetCalls()
  clearClient()
  setSecret('caldav_email', 'test@icloud.com')
  setSecret('caldav_password', 'test-pass')
})

describe('caldav-client — listCalendars', () => {
  it('calls client.login() then client.fetchCalendars()', async () => {
    await listCalendars()
    assert.equal(mockLogin.mock.calls.length, 1)
    assert.equal(mockFetchCalendars.mock.calls.length, 1)
  })

  it('returns structured [{ displayName, url }] objects', async () => {
    const result = await listCalendars()
    assert.deepEqual(result, [
      { displayName: 'Garrett', url: '/cal/garrett/' },
      { displayName: 'Kelsey', url: '/cal/kelsey/' },
    ])
  })

  it('populates calendar_mapping table via INSERT OR IGNORE', async () => {
    await listCalendars()
    const rows = getDb().prepare('SELECT caldav_name, caldav_id, display_label FROM calendar_mapping ORDER BY caldav_id').all()
    assert.equal(rows.length, 2)
    assert.equal(rows[0].caldav_name, 'Garrett')
    assert.equal(rows[0].caldav_id, '/cal/garrett/')
    assert.equal(rows[0].display_label, 'Garrett')
    assert.equal(rows[1].caldav_name, 'Kelsey')
    assert.equal(rows[1].caldav_id, '/cal/kelsey/')
  })

  it('second call reuses cached client — no second login()', async () => {
    await listCalendars()
    await listCalendars()
    assert.equal(mockLogin.mock.calls.length, 1)
  })

  it('throws "Calendar not authorized" when secrets are missing', async () => {
    clearClient()
    // Remove secrets by overwriting with empty — getSecret returns null for missing keys
    const db = getDb()
    db.prepare("DELETE FROM preferences WHERE key = 'caldav_email'").run()
    db.prepare("DELETE FROM preferences WHERE key = 'caldav_password'").run()
    await assert.rejects(
      () => listCalendars(),
      /Calendar not authorized/
    )
  })
})
