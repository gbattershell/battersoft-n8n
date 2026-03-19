// scripts/modules/calendar/prompts.js
// All Claude prompt strings for the calendar module. None in index.js.

export function parseCommandPrompt({ text, today, dayOfWeek, timezone, calendars, existingEvent }) {
  const calendarList = calendars.map(c => c.display_label).join(', ')
  const eventContext = existingEvent
    ? `\nYou are editing an existing event: ${JSON.stringify(existingEvent)}. The user wants to change something about it. Return intent "update" with only the changed fields in "changes".`
    : ''

  return `You are a calendar assistant. Parse the user's command into structured JSON.

Today is ${today} (${dayOfWeek}). User timezone: ${timezone}.
Available calendars: ${calendarList}.
${eventContext}
User command: "${text}"

Return ONLY valid JSON (no markdown, no explanation) matching one of these schemas:

For creating an event:
{"intent":"create","title":"...","calendar":"...","start":"YYYY-MM-DDTHH:mm:ss","duration":60,"confidence":"high"}

For reading events (free-form date):
{"intent":"read","start":"YYYY-MM-DDTHH:mm:ss","end":"YYYY-MM-DDTHH:mm:ss","confidence":"high"}

For deleting an event:
{"intent":"delete","title":"...","calendar":"...","start":"YYYY-MM-DDTHH:mm:ss","duration":60,"confidence":"high"}

For updating an existing event (only changed fields):
{"intent":"update","changes":{"start":"...","duration":30,"calendar":"...","title":"..."},"confidence":"high"}

Rules:
- "calendar" should be the most likely calendar based on context. Default to "${calendars[0]?.display_label || 'Garrett'}" if unclear.
- "duration" defaults to 60 (minutes) if not specified.
- "start" must be an ISO datetime in the user's timezone (${timezone}).
- If the command is ambiguous or you cannot determine the intent, set "confidence" to "low".
- For "update", only include fields that are changing in "changes".`
}
