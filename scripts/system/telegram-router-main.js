// Entry point for the Telegram polling bot Docker service.
// Kept separate so telegram-router.js is safe to import in tests.
import { start } from './telegram-router.js'
import { cleanExpired } from './confirm-timeout.js'

// Run confirmation timeout cleanup every 60 seconds (replaces n8n confirm-timeout workflow —
// n8n's Code node VM sandbox does not support dynamic import()).
setInterval(() => { cleanExpired().catch(() => {}) }, 60_000)

start()
