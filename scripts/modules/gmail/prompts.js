// scripts/modules/gmail/prompts.js
// All Claude prompt strings for the gmail module.

export function buildClassificationPrompt(emails) {
  const emailList = emails.map((e, i) =>
    `${i + 1}. ID: ${e.id}\n   From: ${e.from}\n   Subject: ${e.subject}\n   Snippet: ${e.snippet}`
  ).join('\n\n')

  return `You are classifying emails for a personal inbox assistant. For each email, return one label:

- "actionable" — needs the user's attention (direct messages, important notices, alerts, invitations, tasks)
- "deletable" — no action needed, safe to trash (newsletters, social notifications, marketing)
- "order" — order confirmation, shipping notification, delivery update, or purchase receipt

Respond with a JSON array only — no markdown, no explanation. Example:
[{"id":"abc123","label":"actionable","reason":"Direct email from a person"},{"id":"def456","label":"deletable","reason":"LinkedIn notification"}]

Emails to classify:

${emailList}`
}
