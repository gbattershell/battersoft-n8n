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

// ical.js is NOT mocked — real module used for getEvents tests

const { listCalendars, getEvents, clearClient } = await import('../../../scripts/modules/calendar/caldav-client.js')
const { setSecret, getDb, setPreference } = await import('../../../scripts/core/db.js')

beforeEach(() => {
  mockLogin.mock.resetCalls()
  mockFetchCalendars.mock.resetCalls()
  mockFetchCalendarObjects.mock.resetCalls()
  clearClient()
  setSecret('caldav_email', 'test@icloud.com')
  setSecret('caldav_password', 'test-pass')
  setPreference('timezone', 'America/Chicago')
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

// Sample ICS strings for getEvents tests
const SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:test-uid-123',
  'DTSTART;TZID=America/Chicago:20260321T150000',
  'DTEND;TZID=America/Chicago:20260321T160000',
  'SUMMARY:Dentist',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const ALLDAY_ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:allday-uid-456',
  'DTSTART;VALUE=DATE:20260321',
  'DTEND;VALUE=DATE:20260322',
  'SUMMARY:Spring break',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

describe('caldav-client — getEvents', () => {
  it('returns array of event objects with expected shape', async () => {
    mockFetchCalendarObjects.mock.mockImplementationOnce(async () => [
      { data: SAMPLE_ICS },
    ])
    const result = await getEvents('/cal/garrett/', '2026-03-21T00:00:00', '2026-03-22T00:00:00')
    assert.equal(result.length, 1)
    const ev = result[0]
    assert.equal(ev.uid, 'test-uid-123')
    assert.equal(ev.title, 'Dentist')
    assert.equal(ev.allDay, false)
    assert.equal(ev.calendarUrl, '/cal/garrett/')
    assert.ok(typeof ev.start === 'string', 'start should be a string')
    assert.ok(typeof ev.end === 'string', 'end should be a string')
    assert.ok(typeof ev.duration === 'number', 'duration should be a number')
  })

  it('parses VEVENT iCalendar string into correct JSON shape', async () => {
    mockFetchCalendarObjects.mock.mockImplementationOnce(async () => [
      { data: SAMPLE_ICS },
    ])
    const result = await getEvents('/cal/garrett/', '2026-03-21T00:00:00', '2026-03-22T00:00:00')
    const ev = result[0]
    // Event is 1 hour = 60 minutes
    assert.equal(ev.duration, 60)
    // In America/Chicago, 15:00 Chicago time should be 15:00
    assert.equal(ev.start, '2026-03-21T15:00:00')
    assert.equal(ev.end, '2026-03-21T16:00:00')
  })

  it('handles all-day events with VALUE=DATE', async () => {
    mockFetchCalendarObjects.mock.mockImplementationOnce(async () => [
      { data: ALLDAY_ICS },
    ])
    const result = await getEvents('/cal/garrett/', '2026-03-21T00:00:00', '2026-03-22T00:00:00')
    assert.equal(result.length, 1)
    const ev = result[0]
    assert.equal(ev.uid, 'allday-uid-456')
    assert.equal(ev.title, 'Spring break')
    assert.equal(ev.allDay, true)
    assert.equal(ev.start, '2026-03-21')
    assert.equal(ev.end, '2026-03-22')
    assert.equal(ev.duration, null)
  })

  it('returns empty array when no events match (no data returned)', async () => {
    mockFetchCalendarObjects.mock.mockImplementationOnce(async () => [])
    const result = await getEvents('/cal/garrett/', '2026-03-21T00:00:00', '2026-03-22T00:00:00')
    assert.deepEqual(result, [])
  })

  it('skips objects without .data property', async () => {
    mockFetchCalendarObjects.mock.mockImplementationOnce(async () => [
      { noData: true },
      { data: SAMPLE_ICS },
    ])
    const result = await getEvents('/cal/garrett/', '2026-03-21T00:00:00', '2026-03-22T00:00:00')
    assert.equal(result.length, 1)
    assert.equal(result[0].uid, 'test-uid-123')
  })
})
