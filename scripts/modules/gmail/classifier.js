// scripts/modules/gmail/classifier.js
// Rule-based email classification with Claude haiku fallback for ambiguous emails.
import { ask } from '../../core/claude.js'
import { logger } from '../../core/logger.js'
import { buildClassificationPrompt } from './prompts.js'

const MS_24H = 24 * 60 * 60 * 1000
const MS_90D = 90 * 24 * 60 * 60 * 1000

function emailAgeMs(dateStr) {
  if (!dateStr) return Infinity
  const parsed = Date.parse(dateStr)
  return isNaN(parsed) ? Infinity : Date.now() - parsed
}

// Returns 'actionable', 'deletable', or null (ambiguous — send to Claude).
// Rules are evaluated in priority order: first match wins.
function applyRules(email) {
  if (email.hasAttachment) return 'actionable'                                          // rule 1
  if (email.inReplyTo) return 'actionable'                                              // rule 2
  if (email.labelIds.includes('CATEGORY_PROMOTIONS') ||
      email.labelIds.includes('CATEGORY_SOCIAL')) return 'deletable'                   // rule 3
  if (email.listUnsubscribeHeader && !email.inReplyTo) return 'deletable'              // rule 4
  return null
}

export async function classify(emails) {
  const actionable = []
  const orders = []
  const deletable = []
  const ambiguous = []

  for (const email of emails) {
    if (email.labelIds.includes('STARRED')) continue // never delete starred

    const rule = applyRules(email)
    if (rule === 'actionable') { actionable.push(email); continue }
    if (rule === 'deletable')  { deletable.push(email);  continue }
    ambiguous.push(email)
  }

  if (ambiguous.length === 0) return { actionable, orders, deletable }

  let claudeResults = []
  try {
    const prompt = buildClassificationPrompt(ambiguous)
    const raw = await ask(prompt, 'haiku', { module: 'gmail', maxTokens: 2048 })
    claudeResults = JSON.parse(raw)
  } catch (err) {
    logger.warn('gmail', 'classify-claude-failed', err.message)
    return { actionable, orders, deletable } // graceful degradation
  }

  const resultMap = new Map(claudeResults.map(r => [r.id, r.label]))

  for (const email of ambiguous) {
    const label = resultMap.get(email.id)
    if (label === 'actionable') {
      actionable.push(email)
    } else if (label === 'order') {
      const age = emailAgeMs(email.date)
      if (age < MS_24H) {
        actionable.push(email)       // recent order in digest
      } else if (age >= MS_90D) {
        deletable.push(email)        // old order in deletion batch
      }
      // 24h–90d: silently kept
    } else if (label === 'deletable') {
      deletable.push(email)
    }
    // undefined/unknown label: silently omitted
  }

  return { actionable, orders, deletable }
}
