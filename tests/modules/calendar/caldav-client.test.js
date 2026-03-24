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

const { listCalendars, getEvents, clearClient, createEvent, updateEvent, deleteEvent } = await import('../../../scripts/modules/calendar/caldav-client.js')
const { setSecret, getDb, setPreference } = await import('../../../scripts/core/db.js')

beforeEach(() => {
  mockLogin.mock.resetCalls()
  mockFetchCalendars.mock.resetCalls()
  mockFetchCalendarObjects.mock.resetCalls()
  mockCreateCalendarObject.mock.resetCalls()
  mockUpdateCalendarObject.mock.resetCalls()
  mockDeleteCalendarObject.mock.resetCalls()
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

// ICS fixture for update/delete tests
const EDITABLE_UID = 'editable-uid-789'
const EDITABLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//battersoft//calendar//EN',
  'BEGIN:VEVENT',
  `UID:${EDITABLE_UID}`,
  'DTSTART;TZID=America/Chicago:20260321T150000',
  'DTEND;TZID=America/Chicago:20260321T160000',
  'SUMMARY:Dentist',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const EDITABLE_OBJ = { data: EDITABLE_ICS, url: `/cal/garrett/${EDITABLE_UID}.ics`, etag: '"abc123"' }

describe('caldav-client — createEvent', () => {
  it('calls client.createCalendarObject with valid ICS containing required fields', async () => {
    const result = await createEvent('/cal/garrett/', {
      title: 'Dentist',
      start: '2026-03-21T15:00:00',
      duration: 60,
    })

    assert.equal(mockCreateCalendarObject.mock.calls.length, 1)
    const callArg = mockCreateCalendarObject.mock.calls[0].arguments[0]
    const ics = callArg.iCalString

    assert.ok(ics.includes('BEGIN:VEVENT'), 'ICS must contain BEGIN:VEVENT')
    assert.ok(ics.includes('SUMMARY:Dentist'), 'ICS must contain SUMMARY:Dentist')
    assert.ok(ics.includes('DTSTART;TZID=America/Chicago:'), 'ICS must contain DTSTART with timezone')
    assert.ok(ics.includes('20260321T150000'), 'ICS must contain the correct DTSTART value')
    assert.ok(ics.includes('20260321T160000'), 'ICS must contain the correct DTEND value')
    assert.ok(callArg.iCalString.includes('UID:'), 'ICS must contain a UID')
    assert.equal(callArg.calendar.url, '/cal/garrett/')
    assert.ok(typeof callArg.filename === 'string' && callArg.filename.endsWith('.ics'))

    assert.ok(typeof result.uid === 'string' && result.uid.length > 0, 'returns { uid }')
  })

  it('defaults duration to 60 minutes when not specified', async () => {
    await createEvent('/cal/garrett/', {
      title: 'Quick call',
      start: '2026-03-21T09:00:00',
    })
    const ics = mockCreateCalendarObject.mock.calls[0].arguments[0].iCalString
    assert.ok(ics.includes('20260321T100000'), 'DTEND should be 60 minutes after start')
  })

  it('uses the uid returned in the filename', async () => {
    const result = await createEvent('/cal/garrett/', {
      title: 'Meeting',
      start: '2026-03-22T10:00:00',
      duration: 30,
    })
    const callArg = mockCreateCalendarObject.mock.calls[0].arguments[0]
    assert.ok(callArg.filename.includes(result.uid), 'filename must include the returned uid')
    assert.ok(callArg.iCalString.includes(result.uid), 'ICS body must include the returned uid')
  })
})

describe('caldav-client — updateEvent', () => {
  it('updates DTSTART when changes.start is provided', async () => {
    mockFetchCalendarObjects.mock.mockImplementationOnce(async () => [EDITABLE_OBJ])

    await updateEvent('/cal/garrett/', EDITABLE_UID, { start: '2026-03-21T16:00:00' })

    assert.equal(mockFetchCalendarObjects.mock.calls.length, 1)
    assert.equal(mockUpdateCalendarObject.mock.calls.length, 1)
    const updatedIcs = mockUpdateCalendarObject.mock.calls[0].arguments[0].calendarObject.data
    assert.ok(updatedIcs.includes('20260321T160000'), 'Updated ICS must contain new DTSTART time')
    assert.ok(!updatedIcs.includes('20260321T150000'), 'Updated ICS must not contain old DTSTART time')
  })

  it('updates SUMMARY when changes.title is provided', async () => {
    mockFetchCalendarObjects.mock.mockImplementationOnce(async () => [EDITABLE_OBJ])

    await updateEvent('/cal/garrett/', EDITABLE_UID, { title: 'Root Canal' })

    assert.equal(mockUpdateCalendarObject.mock.calls.length, 1)
    const updatedIcs = mockUpdateCalendarObject.mock.calls[0].arguments[0].calendarObject.data
    assert.ok(updatedIcs.includes('Root Canal'), 'Updated ICS must contain new title')
    assert.ok(!updatedIcs.includes('Dentist'), 'Updated ICS must not contain old title')
  })

  it('updates DTEND when changes.duration is provided', async () => {
    mockFetchCalendarObjects.mock.mockImplementationOnce(async () => [EDITABLE_OBJ])

    await updateEvent('/cal/garrett/', EDITABLE_UID, { duration: 90 })

    assert.equal(mockUpdateCalendarObject.mock.calls.length, 1)
    const updatedIcs = mockUpdateCalendarObject.mock.calls[0].arguments[0].calendarObject.data
    // Start is 15:00, + 90 min = 16:30
    assert.ok(updatedIcs.includes('163000'), 'Updated ICS must contain DTEND at 16:30')
  })

  it('passes correct url and etag to updateCalendarObject', async () => {
    mockFetchCalendarObjects.mock.mockImplementationOnce(async () => [EDITABLE_OBJ])
    await updateEvent('/cal/garrett/', EDITABLE_UID, { title: 'New Title' })

    const callArg = mockUpdateCalendarObject.mock.calls[0].arguments[0]
    assert.equal(callArg.calendarObject.url, EDITABLE_OBJ.url)
    assert.equal(callArg.calendarObject.etag, EDITABLE_OBJ.etag)
  })

  it('throws "not found" when uid does not match any object', async () => {
    mockFetchCalendarObjects.mock.mockImplementationOnce(async () => [EDITABLE_OBJ])
    await assert.rejects(
      () => updateEvent('/cal/garrett/', 'nonexistent-uid', { title: 'X' }),
      /not found/
    )
  })
})

describe('caldav-client — deleteEvent', () => {
  it('calls deleteCalendarObject with correct url and etag', async () => {
    mockFetchCalendarObjects.mock.mockImplementationOnce(async () => [EDITABLE_OBJ])

    await deleteEvent('/cal/garrett/', EDITABLE_UID)

    assert.equal(mockFetchCalendarObjects.mock.calls.length, 1)
    assert.equal(mockDeleteCalendarObject.mock.calls.length, 1)
    const callArg = mockDeleteCalendarObject.mock.calls[0].arguments[0]
    assert.equal(callArg.calendarObject.url, EDITABLE_OBJ.url)
    assert.equal(callArg.calendarObject.etag, EDITABLE_OBJ.etag)
  })

  it('throws "not found" when uid does not match any object', async () => {
    mockFetchCalendarObjects.mock.mockImplementationOnce(async () => [EDITABLE_OBJ])
    await assert.rejects(
      () => deleteEvent('/cal/garrett/', 'unknown-uid'),
      /not found/
    )
  })
})
