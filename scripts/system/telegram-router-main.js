// Entry point for the Telegram polling bot Docker service.
// Kept separate so telegram-router.js is safe to import in tests.
import { start } from './telegram-router.js'
start()
