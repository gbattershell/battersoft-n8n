// scripts/modules/gmail/setup.js
// One-time OAuth setup. Run on the HOST (not in Docker):
//   source .env && node scripts/modules/gmail/setup.js
//
// Pre-conditions:
//   1. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ENCRYPTION_KEY, DB_PATH set in environment
//   2. http://localhost:8080/callback added as authorized redirect URI in Google Cloud Console
import { createServer } from 'node:http'
import { google } from 'googleapis'
import { setSecret } from '../../core/db.js'

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.')
  console.error('Run: source .env && node scripts/modules/gmail/setup.js')
  process.exit(1)
}
if (!process.env.ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY must be set. Generate: openssl rand -hex 32')
  process.exit(1)
}

const REDIRECT_URI = 'http://localhost:8080/callback'
const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI)

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/gmail.modify'],
  prompt: 'consent',
})

console.log('\nGmail OAuth Setup')
console.log('-'.repeat(50))
console.log('\nOpen this URL in your browser:\n')
console.log(authUrl)
console.log('\nWaiting for authorization at http://localhost:8080/callback ...\n')

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8080')
  const code = url.searchParams.get('code')
  const authError = url.searchParams.get('error')

  if (authError) {
    res.writeHead(400)
    res.end(`<html><body><h2>Authorization failed: ${authError}</h2></body></html>`)
    console.error(`Authorization failed: ${authError}`)
    server.close()
    process.exit(1)
  }

  if (!code) return

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<html><body><h2>Authorization successful! You can close this tab.</h2></body></html>')
  server.close()

  try {
    const { tokens } = await oauth2Client.getToken(code)
    if (!tokens.refresh_token) {
      console.error('No refresh_token returned.')
      console.error('Try revoking access at https://myaccount.google.com/permissions and re-running setup.')
      process.exit(1)
    }
    setSecret('gmail_refresh_token', tokens.refresh_token)
    console.log('Gmail authorized. Refresh token stored securely in SQLite.')
  } catch (err) {
    console.error('Failed to exchange authorization code:', err.message)
    process.exit(1)
  }
})

server.listen(8080, () => {})
