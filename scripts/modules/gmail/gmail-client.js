// scripts/modules/gmail/gmail-client.js
// All Gmail API calls go through here. Manages OAuth2 client and token refresh.
import { google } from 'googleapis'
import { getSecret, setSecret } from '../../core/db.js'
import { logger } from '../../core/logger.js'

function getOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  const refreshToken = getSecret('gmail_refresh_token')
  if (!refreshToken) {
    throw new Error('Gmail not authorized — run: source .env && node scripts/modules/gmail/setup.js')
  }
  client.setCredentials({ refresh_token: refreshToken })
  client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      setSecret('gmail_refresh_token', tokens.refresh_token)
      logger.info('gmail-client', 'token-rotated', 'refresh token updated')
    }
  })
  return client
}

function getGmailApi() {
  return google.gmail({ version: 'v1', auth: getOAuth2Client() })
}

function extractHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
}

function hasAttachmentParts(parts = []) {
  return parts.some(p => p.filename && p.filename.length > 0)
}

export async function listEmails({ maxResults = 50, query = 'is:unread -is:starred' } = {}) {
  const gmail = getGmailApi()
  const listRes = await gmail.users.messages.list({ userId: 'me', maxResults, q: query })
  const messages = listRes.data.messages ?? []
  if (messages.length === 0) return []

  const emails = await Promise.all(messages.map(async ({ id }) => {
    const msgRes = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
      fields: 'id,threadId,labelIds,snippet,payload(mimeType,headers,parts(filename,mimeType))',
    })
    const msg = msgRes.data
    const headers = msg.payload?.headers ?? []
    const parts = msg.payload?.parts ?? []
    return {
      id: msg.id,
      threadId: msg.threadId,
      subject: extractHeader(headers, 'Subject') ?? '(no subject)',
      from: extractHeader(headers, 'From') ?? '(unknown)',
      snippet: msg.snippet ?? '',
      date: extractHeader(headers, 'Date'),
      labelIds: msg.labelIds ?? [],
      hasAttachment: hasAttachmentParts(parts),
      listUnsubscribeHeader: extractHeader(headers, 'List-Unsubscribe'),
      inReplyTo: extractHeader(headers, 'In-Reply-To'),
    }
  }))
  return emails
}

export async function trashEmail(id) {
  const gmail = getGmailApi()
  await gmail.users.messages.trash({ userId: 'me', id })
}

export async function trashEmails(ids) {
  const gmail = getGmailApi()
  let succeeded = 0
  let failed = 0
  await Promise.all(ids.map(async (id) => {
    try {
      await gmail.users.messages.trash({ userId: 'me', id })
      succeeded++
    } catch (err) {
      logger.error('gmail-client', 'trash-failed', `${id}: ${err.message}`)
      failed++
    }
  }))
  return { succeeded, failed }
}
