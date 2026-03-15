// scripts/core/logger.js

function log(level, module, action, detail = '') {
  const ts = new Date().toISOString()
  const parts = [`[${ts}]`, `[${level.toUpperCase()}]`, `[${module}]`, action]
  if (detail) parts.push(`— ${detail}`)
  console.log(parts.join(' '))
}

export const logger = {
  info:  (module, action, detail) => log('info',  module, action, detail),
  warn:  (module, action, detail) => log('warn',  module, action, detail),
  error: (module, action, detail) => log('error', module, action, detail),
}
