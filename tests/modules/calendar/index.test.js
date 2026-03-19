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
const { getDb, run: dbRun, query, queryOne, setPreference } = await import('../../../scripts/core/db.js')

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

describe('handleCallback', () => {
  const eventData = JSON.stringify({
    calendarUrl: 'https://cal/home',
    uid: 'uid1',
    title: 'Dentist',
    start: '2026-03-20T15:00:00',
    duration: 60,
    calendar: 'Garrett',
  })
  const exp = () => Math.floor(Date.now() / 1000) + 300

  it('cal_edit_<token>: deletes row, writes cal_edit_await row, sends "What would you like to change"', async () => {
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      ['cal_edit_tok1', 'Edit Dentist', eventData, exp()]
    )
    await handleCallback({ id: 'cq1', data: 'cal_edit_tok1' })

    // original row deleted
    const deleted = queryOne("SELECT * FROM pending_confirmations WHERE action_id = ?", ['cal_edit_tok1'])
    assert.equal(deleted, undefined, 'expected cal_edit_tok1 row to be deleted')

    // new cal_edit_await_ row written
    const awaitRows = query("SELECT action_id FROM pending_confirmations WHERE action_id LIKE 'cal_edit_await_%'")
    assert.equal(awaitRows.length, 1, 'expected one cal_edit_await_ row')

    // send called with "What would you like to change"
    const sends = getSendCalls()
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('What would you like to change'), 'expected "What would you like to change" in message')
  })

  it('cal_delete_<token>: deletes row, writes cal_confirm_delete row, sendWithButtons with delete confirmation', async () => {
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      ['cal_delete_tok1', 'Delete Dentist', eventData, exp()]
    )
    await handleCallback({ id: 'cq1', data: 'cal_delete_tok1' })

    // original row deleted
    const deleted = queryOne("SELECT * FROM pending_confirmations WHERE action_id = ?", ['cal_delete_tok1'])
    assert.equal(deleted, undefined, 'expected cal_delete_tok1 row to be deleted')

    // new cal_confirm_delete_ row written
    const confirmRows = query("SELECT action_id FROM pending_confirmations WHERE action_id LIKE 'cal_confirm_delete_%'")
    assert.equal(confirmRows.length, 1, 'expected one cal_confirm_delete_ row')

    // sendWithButtons called with delete buttons
    const sends = getSendCalls()
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('Yes, Delete') || body.includes('🗑'), 'expected delete button in message')
    assert.ok(body.includes('Cancel') || body.includes('❌'), 'expected cancel button in message')
  })

  it('cal_confirm_delete_<token>: calls deleteEvent, deletes row, sends "Deleted", logs audit', async () => {
    const confirmData = JSON.stringify({
      calendarUrl: 'https://cal/home',
      uid: 'uid1',
      title: 'Dentist',
      start: '2026-03-20T15:00:00',
      calendar: 'Garrett',
    })
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      ['cal_confirm_delete_tok1', 'Delete Dentist', confirmData, exp()]
    )
    await handleCallback({ id: 'cq1', data: 'cal_confirm_delete_tok1' })

    // deleteEvent called with calendarUrl and uid
    assert.equal(mockDeleteEvent.mock.calls.length, 1, 'expected deleteEvent to be called once')
    assert.equal(mockDeleteEvent.mock.calls[0].arguments[0], 'https://cal/home')
    assert.equal(mockDeleteEvent.mock.calls[0].arguments[1], 'uid1')

    // row deleted
    const deleted = queryOne("SELECT * FROM pending_confirmations WHERE action_id = ?", ['cal_confirm_delete_tok1'])
    assert.equal(deleted, undefined, 'expected row to be deleted')

    // send called with "Deleted"
    const sends = getSendCalls()
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('Deleted'), 'expected "Deleted" in message')

    // audit logged
    const auditRows = query("SELECT * FROM audit_log WHERE module = 'calendar' AND action = 'delete_event'")
    assert.equal(auditRows.length, 1, 'expected one delete_event audit log entry')
  })

  it('cal_undo_<token> undoType create: calls deleteEvent, deletes row, sends undo message, logs undo_create', async () => {
    const undoData = JSON.stringify({
      undoType: 'create',
      calendarUrl: 'https://cal/home',
      uid: 'uid1',
    })
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      ['cal_undo_tok1', 'Undo create', undoData, exp()]
    )
    await handleCallback({ id: 'cq1', data: 'cal_undo_tok1' })

    // deleteEvent called
    assert.equal(mockDeleteEvent.mock.calls.length, 1, 'expected deleteEvent to be called')
    assert.equal(mockDeleteEvent.mock.calls[0].arguments[1], 'uid1')

    // row deleted
    const deleted = queryOne("SELECT * FROM pending_confirmations WHERE action_id = ?", ['cal_undo_tok1'])
    assert.equal(deleted, undefined, 'expected row to be deleted')

    // send called with undo message
    const sends = getSendCalls()
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('undo') || body.includes('Undo') || body.includes('↩️'), 'expected undo message')

    // audit logged
    const auditRows = query("SELECT * FROM audit_log WHERE module = 'calendar' AND action = 'undo_create'")
    assert.equal(auditRows.length, 1, 'expected one undo_create audit log entry')
  })

  it('cal_undo_<token> undoType update: calls updateEvent with original data, logs undo_update', async () => {
    const undoData = JSON.stringify({
      undoType: 'update',
      calendarUrl: 'https://cal/home',
      uid: 'uid1',
      original: { title: 'Old Title', start: '2026-03-20T14:00:00' },
    })
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      ['cal_undo_tok1', 'Undo update', undoData, exp()]
    )
    await handleCallback({ id: 'cq1', data: 'cal_undo_tok1' })

    // updateEvent called with calendarUrl, uid, and original
    assert.equal(mockUpdateEvent.mock.calls.length, 1, 'expected updateEvent to be called once')
    assert.equal(mockUpdateEvent.mock.calls[0].arguments[0], 'https://cal/home')
    assert.equal(mockUpdateEvent.mock.calls[0].arguments[1], 'uid1')
    assert.deepEqual(mockUpdateEvent.mock.calls[0].arguments[2], { title: 'Old Title', start: '2026-03-20T14:00:00' })

    // audit logged
    const auditRows = query("SELECT * FROM audit_log WHERE module = 'calendar' AND action = 'undo_update'")
    assert.equal(auditRows.length, 1, 'expected one undo_update audit log entry')
  })

  it('cal_conflict_confirm_<token> actionType create: calls createEvent, writes cal_undo row, sendWithButtons with Edit button, logs create_event', async () => {
    const conflictData = JSON.stringify({
      actionType: 'create',
      calendarUrl: 'https://cal/home',
      event: { title: 'Dentist', start: '2026-03-20T15:00:00', duration: 60, calendar: 'Garrett' },
    })
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      ['cal_conflict_confirm_tok1', 'Conflict confirm Dentist', conflictData, exp()]
    )
    mockCreateEvent.mock.mockImplementationOnce(async () => ({ uid: 'uid-new' }))

    await handleCallback({ id: 'cq1', data: 'cal_conflict_confirm_tok1' })

    // createEvent called
    assert.equal(mockCreateEvent.mock.calls.length, 1, 'expected createEvent to be called')

    // cal_undo row written
    const undoRows = query("SELECT action_id FROM pending_confirmations WHERE action_id LIKE 'cal_undo_%'")
    assert.equal(undoRows.length, 1, 'expected one cal_undo_ row')

    // sendWithButtons called with Edit button
    const sends = getSendCalls()
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('✏️ Edit') || body.includes('Edit'), 'expected Edit button')

    // audit logged
    const auditRows = query("SELECT * FROM audit_log WHERE module = 'calendar' AND action = 'create_event'")
    assert.equal(auditRows.length, 1, 'expected one create_event audit log entry')
  })

  it('cal_conflict_confirm_<token> actionType update: calls updateEvent, writes cal_undo row, sendWithButtons with Undo button', async () => {
    const conflictData = JSON.stringify({
      actionType: 'update',
      calendarUrl: 'https://cal/home',
      uid: 'uid1',
      changes: { title: 'New Title' },
      original: { title: 'Old Title' },
    })
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      ['cal_conflict_confirm_tok1', 'Conflict confirm update', conflictData, exp()]
    )

    await handleCallback({ id: 'cq1', data: 'cal_conflict_confirm_tok1' })

    // updateEvent called with calendarUrl, uid, changes
    assert.equal(mockUpdateEvent.mock.calls.length, 1, 'expected updateEvent to be called once')
    assert.equal(mockUpdateEvent.mock.calls[0].arguments[0], 'https://cal/home')
    assert.equal(mockUpdateEvent.mock.calls[0].arguments[1], 'uid1')
    assert.deepEqual(mockUpdateEvent.mock.calls[0].arguments[2], { title: 'New Title' })

    // cal_undo row written
    const undoRows = query("SELECT action_id FROM pending_confirmations WHERE action_id LIKE 'cal_undo_%'")
    assert.equal(undoRows.length, 1, 'expected one cal_undo_ row')

    // sendWithButtons with "Updated." and Undo button
    const sends = getSendCalls()
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('Updated') || body.includes('✅'), 'expected Updated message')
    assert.ok(body.includes('Undo') || body.includes('↩️'), 'expected Undo button')
  })

  it('expired/missing row: sends "This action has expired."', async () => {
    await handleCallback({ id: 'cq1', data: 'cal_edit_no_such_token' })

    const sends = getSendCalls()
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('expired'), 'expected "expired" in message')
  })

  it('cal_cancel_<token>: deletes matching row(s), sends "Cancelled."', async () => {
    dbRun(
      "INSERT INTO pending_confirmations (action_id, module, description, data, expires_at) VALUES (?, 'calendar', ?, ?, ?)",
      ['cal_conflict_confirm_tok1', 'Conflict confirm', eventData, exp()]
    )
    await handleCallback({ id: 'cq1', data: 'cal_cancel_tok1' })

    // row deleted
    const remaining = query("SELECT action_id FROM pending_confirmations WHERE action_id LIKE '%tok1%'")
    assert.equal(remaining.length, 0, 'expected matching row to be deleted')

    // send called with "Cancelled."
    const sends = getSendCalls()
    const body = JSON.stringify(sends.map(c => c.arguments[1]))
    assert.ok(body.includes('Cancelled'), 'expected "Cancelled" in message')
  })
})
