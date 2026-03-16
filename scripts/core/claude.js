// scripts/core/claude.js
import Anthropic from '@anthropic-ai/sdk'
import { run as dbRun } from './db.js'

const MODEL_IDS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
}

export async function ask(prompt, model = 'haiku', { module = 'unknown' } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — this feature requires Claude. Set it in .env to enable AI features.')
  }
  const modelId = MODEL_IDS[model]
  if (!modelId) throw new Error(`Unknown model: '${model}'. Use 'haiku' or 'sonnet'.`)

  // Rolling 30-day retention cleanup
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400
  try { dbRun('DELETE FROM token_log WHERE ts < ?', [cutoff]) } catch { /* ignore */ }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const message = await client.messages.create({
    model: modelId,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  })

  try {
    dbRun(
      'INSERT INTO token_log (ts, module, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
      [Math.floor(Date.now() / 1000), module, modelId, message.usage.input_tokens, message.usage.output_tokens]
    )
  } catch { /* don't fail the request if logging fails */ }

  return message.content[0].text
}
