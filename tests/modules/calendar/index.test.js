import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.ENCRYPTION_KEY = 'a'.repeat(64)
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.ALLOWED_CHAT_ID = '123'
process.env.ANTHROPIC_API_KEY = 'test-key'

const fetchMock = mock.fn(async () => ({ ok: true, json: async () => ({}) }))
global.fetch = fetchMock

const mockGetEvents = mock.fn(async () => [])
const mockListCalendars = mock.fn(async () => [])
const mockCreateEvent = mock.fn(async () => ({ uid: 'new-uid' }))
const mockUpdateEvent = mock.fn(async () => {})
const mockDeleteEvent = mock.fn(async () => {})
mock.module('../../../scripts/modules/calendar/caldav-client.js', {
  namedExports: {
    getEvents: mockGetEvents,
    listCalendars: mockListCalendars,
    createEvent: mockCreateEvent,
    updateEvent: mockUpdateEvent,
    deleteEvent: mockDeleteEvent,
    clearClient: () => {},
  },
})

const mockParse = mock.fn(async () => ({ intent: 'unknown', confidence: 'low' }))
mock.module('../../../scripts/modules/calendar/parser.js', {
  namedExports: { parse: mockParse },
})

// Mock http-server to avoid side-effects from registerRoute
mock.module('../../../scripts/system/http-server.js', {
  namedExports: { registerRoute: () => {} },
})

const { run, handleCallback } = await import('../../../scripts/modules/calendar/index.js')
const { getDb, run: dbRun, query, setPreference } = await import('../../../scripts/core/db.js')

function getSendCalls() {
  return fetchMock.mock.calls.filter(c => String(c.arguments[0]).includes('sendMessage'))
}

beforeEach(() => {
  fetchMock.mock.resetCalls()
  mockGetEvents.mock.resetCalls()
  mockListCalendars.mock.resetCalls()
  mockParse.mock.resetCalls()
  mockCreateEvent.mock.resetCalls()
  mockUpdateEvent.mock.resetCalls()
  mockDeleteEvent.mock.resetCalls()
  getDb().prepare('DELETE FROM pending_confirmations').run()
  getDb().prepare('DELETE FROM audit_log').run()
  getDb().prepare('DELETE FROM module_status').run()
  getDb().prepare('DELETE FROM calendar_mapping').run()
  dbRun(
    "INSERT INTO calendar_mapping (caldav_name, caldav_id, display_label, emoji) VALUES (?, ?, ?, ?)",
    ['Garrett', '/cal/garrett/', 'Garrett', '🧑']
  )
  dbRun(
    "INSERT INTO calendar_mapping (caldav_name, caldav_id, display_label, emoji) VALUES (?, ?, ?, ?)",
    ['Kelsey', '/cal/kelsey/', 'Kelsey', '💁']
  )
  setPreference('timezone', 'America/Chicago')
})

describe('run() — read flow', () => {
  it('calls getEvents for each calendar (2 calls, one per calendar row)', async () => {
    await run({ message: { text: 'cal today' } })
    assert.equal(mockGetEvents.mock.calls.length, 2)
  })

  it('includes event title and calendar emoji in the sent message', async () => {
    mockGetEvents.mock.mockImplementationOnce(async () => [{
      uid: 'evt-1', title: 'Dentist', start: '2026-03-19T15:00:00',
      end: '2026-03-19T16:00:00', duration: 60, allDay: false, calendarUrl: '/cal/garrett/'
    }])
    await run({ message: { text: 'cal today' } })
    const sends = getSendCalls()
    assert.ok(sends.length > 0, 'expected at least one sendMessage call')
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('Dentist'), 'expected event title in message')
    assert.ok(body.includes('🧑'), 'expected calendar emoji in message')
  })

  it('writes two pending_confirmations rows per event (cal_edit_* and cal_delete_*)', async () => {
    mockGetEvents.mock.mockImplementationOnce(async () => [{
      uid: 'evt-1', title: 'Dentist', start: '2026-03-19T15:00:00',
      end: '2026-03-19T16:00:00', duration: 60, allDay: false, calendarUrl: '/cal/garrett/'
    }])
    await run({ message: { text: 'cal today' } })
    const rows = query('SELECT action_id FROM pending_confirmations WHERE module = ?', ['calendar'])
    const editRows = rows.filter(r => r.action_id.startsWith('cal_edit_'))
    const deleteRows = rows.filter(r => r.action_id.startsWith('cal_delete_'))
    assert.equal(editRows.length, 1, 'expected one cal_edit_ row')
    assert.equal(deleteRows.length, 1, 'expected one cal_delete_ row')
  })

  it('HTML-escapes event titles with special characters', async () => {
    mockGetEvents.mock.mockImplementationOnce(async () => [{
      uid: 'evt-2', title: '<b>Bold Event</b>', start: '2026-03-19T10:00:00',
      end: '2026-03-19T11:00:00', duration: 60, allDay: false, calendarUrl: '/cal/garrett/'
    }])
    await run({ message: { text: 'cal today' } })
    const sends = getSendCalls()
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('&lt;b&gt;'), 'expected HTML-escaped title')
    assert.ok(!body.includes('<b>Bold'), 'raw HTML should not appear in message')
  })

  it('sends "No events" message when no events are found', async () => {
    await run({ message: { text: 'cal today' } })
    const sends = getSendCalls()
    assert.ok(sends.length > 0, 'expected at least one sendMessage call')
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('No events'), 'expected "No events" in message')
  })

  it('calls getEvents with tomorrow\'s date when text is "cal tomorrow"', async () => {
    await run({ message: { text: 'cal tomorrow' } })
    assert.equal(mockGetEvents.mock.calls.length, 2)
    const startArg = mockGetEvents.mock.calls[0].arguments[1]
    const tz = 'America/Chicago'
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: tz })
    assert.ok(startArg.startsWith(tomorrowStr), `expected start to be tomorrow (${tomorrowStr}), got ${startArg}`)
  })

  it('calls getEvents with a week-spanning range for "cal this week"', async () => {
    await run({ message: { text: 'cal this week' } })
    assert.equal(mockGetEvents.mock.calls.length, 2)
    const startArg = mockGetEvents.mock.calls[0].arguments[1]
    const endArg = mockGetEvents.mock.calls[0].arguments[2]
    const startDate = new Date(startArg)
    const endDate = new Date(endArg)
    const diffMs = endDate - startDate
    const diffDays = diffMs / (1000 * 60 * 60 * 24)
    assert.ok(startDate < endDate, 'start should be earlier than end')
    assert.ok(diffDays >= 6, `expected range of at least 6 days, got ${diffDays}`)
  })

  it('records heartbeat in module_status table', async () => {
    await run({ message: { text: 'cal today' } })
    const rows = query('SELECT * FROM module_status WHERE module = ?', ['calendar'])
    assert.ok(rows.length > 0, 'expected heartbeat row in module_status')
  })
})

describe('create flow', () => {
  it('normal create: calls createEvent, sends confirmation with Edit button, writes cal_undo and cal_edit rows, logs audit', async () => {
    mockParse.mock.mockImplementationOnce(async () => ({
      intent: 'create',
      title: 'Dentist',
      start: '2026-03-20T15:00:00',
      duration: 60,
      calendar: 'Garrett',
      confidence: 'high',
    }))
    mockGetEvents.mock.mockImplementation(async () => [])

    await run({ message: { text: 'cal add dentist Friday 3pm' } })

    // createEvent called once
    assert.equal(mockCreateEvent.mock.calls.length, 1, 'expected createEvent to be called once')

    // confirmation message sent with Edit button
    const sends = getSendCalls()
    assert.ok(sends.length >= 1, 'expected at least one sendMessage call')
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('Dentist'), 'expected title in confirmation message')
    assert.ok(body.includes('✏️ Edit'), 'expected Edit button in confirmation message')

    // cal_undo row written
    const rows = query('SELECT action_id FROM pending_confirmations WHERE module = ?', ['calendar'])
    const undoRows = rows.filter(r => r.action_id.startsWith('cal_undo_'))
    assert.equal(undoRows.length, 1, 'expected one cal_undo_ row')

    // cal_edit row written (from the create confirmation)
    const editRows = rows.filter(r => r.action_id.startsWith('cal_edit_'))
    assert.ok(editRows.length >= 1, 'expected at least one cal_edit_ row')

    // audit logged
    const auditRows = query("SELECT * FROM audit_log WHERE module = 'calendar' AND action = 'create_event'")
    assert.equal(auditRows.length, 1, 'expected one create_event audit log entry')

    mockGetEvents.mock.mockImplementation(async () => [])
  })

  it('hard conflict: does NOT call createEvent, sends conflict warning with Yes/Cancel buttons, writes cal_conflict_confirm row', async () => {
    mockParse.mock.mockImplementationOnce(async () => ({
      intent: 'create',
      title: 'Dentist',
      start: '2026-03-20T15:00:00',
      duration: 60,
      calendar: 'Garrett',
      confidence: 'high',
    }))
    // Overlapping event: starts at 14:30, ends at 15:30 — overlaps with 15:00–16:00
    mockGetEvents.mock.mockImplementation(async () => [{
      uid: 'abc',
      title: 'Yoga',
      start: '2026-03-20T14:30:00',
      end: '2026-03-20T15:30:00',
      allDay: false,
      calendarUrl: '/cal/garrett/',
    }])

    await run({ message: { text: 'cal add dentist Friday 3pm' } })

    // createEvent NOT called
    assert.equal(mockCreateEvent.mock.calls.length, 0, 'expected createEvent NOT to be called on hard conflict')

    // conflict warning sent with Yes and Cancel buttons
    const sends = getSendCalls()
    assert.ok(sends.length >= 1, 'expected at least one sendMessage call')
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('✅ Yes') || body.includes('Yes'), 'expected Yes button in conflict warning')
    assert.ok(body.includes('❌ Cancel') || body.includes('Cancel'), 'expected Cancel button in conflict warning')

    // cal_conflict_confirm row written
    const rows = query('SELECT action_id FROM pending_confirmations WHERE module = ?', ['calendar'])
    const conflictRows = rows.filter(r => r.action_id.startsWith('cal_conflict_confirm_'))
    assert.equal(conflictRows.length, 1, 'expected one cal_conflict_confirm_ row')

    mockGetEvents.mock.mockImplementation(async () => [])
  })

  it('soft conflict: calls createEvent, sends advisory follow-up message, no conflict warning', async () => {
    mockParse.mock.mockImplementationOnce(async () => ({
      intent: 'create',
      title: 'Dentist',
      start: '2026-03-20T15:00:00',
      duration: 60,
      calendar: 'Garrett',
      confidence: 'high',
    }))
    // Event ends at 14:45 — 15 min before new event starts at 15:00 → soft conflict (gap ≤ 30 min)
    mockGetEvents.mock.mockImplementation(async () => [{
      uid: 'xyz',
      title: 'Lunch',
      start: '2026-03-20T13:45:00',
      end: '2026-03-20T14:45:00',
      allDay: false,
      calendarUrl: '/cal/garrett/',
    }])

    await run({ message: { text: 'cal add dentist Friday 3pm' } })

    // createEvent called
    assert.equal(mockCreateEvent.mock.calls.length, 1, 'expected createEvent to be called for soft conflict')

    // advisory sent (should be at least 2 sendMessage calls: confirmation + advisory)
    const sends = getSendCalls()
    assert.ok(sends.length >= 2, 'expected confirmation + advisory message (at least 2 sendMessage calls)')
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('💡') || body.includes('nearby') || body.includes('Lunch'), 'expected advisory message about nearby event')

    // no conflict warning row
    const rows = query('SELECT action_id FROM pending_confirmations WHERE module = ?', ['calendar'])
    const conflictRows = rows.filter(r => r.action_id.startsWith('cal_conflict_confirm_'))
    assert.equal(conflictRows.length, 0, 'expected no cal_conflict_confirm_ row for soft conflict')

    mockGetEvents.mock.mockImplementation(async () => [])
  })

  it('no conflict: calls createEvent, sends exactly one message, no advisory', async () => {
    mockParse.mock.mockImplementationOnce(async () => ({
      intent: 'create',
      title: 'Dentist',
      start: '2026-03-20T15:00:00',
      duration: 60,
      calendar: 'Garrett',
      confidence: 'high',
    }))
    mockGetEvents.mock.mockImplementation(async () => [])

    await run({ message: { text: 'cal add dentist Friday 3pm' } })

    // createEvent called
    assert.equal(mockCreateEvent.mock.calls.length, 1, 'expected createEvent to be called')

    // only one sendMessage call (no advisory)
    const sends = getSendCalls()
    assert.equal(sends.length, 1, 'expected exactly one sendMessage call (no advisory)')

    mockGetEvents.mock.mockImplementation(async () => [])
  })
})
