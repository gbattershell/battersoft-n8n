// scripts/modules/calendar/parser.js
import { ask } from '../../core/claude.js'
import { query, getPreference } from '../../core/db.js'
import { parseCommandPrompt } from './prompts.js'
import { logger } from '../../core/logger.js'

export async function parse(text, { existingEvent } = {}) {
  const calendars = query('SELECT display_label FROM calendar_mapping ORDER BY display_order')
  const tz = getPreference('timezone') || 'America/Chicago'
  const now = new Date()
  const today = now.toLocaleDateString('en-CA', { timeZone: tz }) // YYYY-MM-DD
  const dayOfWeek = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' })

  const prompt = parseCommandPrompt({ text, today, dayOfWeek, timezone: tz, calendars, existingEvent })
  const raw = await ask(prompt, 'haiku', { module: 'calendar' })

  try {
    // Extract JSON from response (Claude sometimes wraps in markdown)
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in response')
    return JSON.parse(jsonMatch[0])
  } catch (err) {
    logger.warn('calendar-parser', 'parse-failed', `Could not parse: ${raw.slice(0, 100)}`)
    return { intent: 'unknown', confidence: 'low' }
  }
}
