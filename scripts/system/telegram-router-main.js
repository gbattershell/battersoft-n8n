// Entry point for the Telegram polling bot Docker service.
// Kept separate so telegram-router.js is safe to import in tests.
import { start } from './telegram-router.js'
import { cleanExpired } from './confirm-timeout.js'
import { startHttpServer } from './http-server.js'

// Import modules to trigger registerRoute() side-effects
import '../modules/gmail/index.js'
import '../modules/tiller/index.js'

// HTTP server for n8n scheduled triggers — must start before polling loop
startHttpServer(3000)

// Run confirmation timeout cleanup every 60 seconds
setInterval(() => { cleanExpired().catch(() => {}) }, 60_000)

start()
