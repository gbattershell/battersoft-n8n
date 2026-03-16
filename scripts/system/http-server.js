// scripts/system/http-server.js
// Reusable HTTP server for n8n scheduled trigger calls.
// Modules call registerRoute() at import time.
// startHttpServer() is called once in telegram-router-main.js before the polling loop.
import { createServer } from 'node:http'
import { logger } from '../core/logger.js'

const routes = new Map()

export function registerRoute(method, path, handler) {
  routes.set(`${method} ${path}`, handler)
}

export function startHttpServer(port) {
  const server = createServer(async (req, res) => {
    const key = `${req.method} ${req.url}`
    const handler = routes.get(key)
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }
    try {
      await handler(req, res)
    } catch (err) {
      logger.error('http-server', 'handler-error', err.message)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
    }
  })

  server.on('error', (err) => {
    logger.error('http-server', 'startup-error', err.message)
    process.exit(1)
  })

  server.listen(port, () => {
    logger.info('http-server', 'started', `listening on port ${port}`)
  })

  return server
}
