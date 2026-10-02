import { createServer } from 'node:http'
import process from 'node:process'
import { DEFAULTS, defaultPort } from './config/defaults.js'

/** PORT is reserved for the metrics sidecar; the server reads its own variable. */
export function resolvePort(env = process.env) {
  const fromEnv = env.VY_LISTEN_PORT
  return fromEnv ? Number(fromEnv) : defaultPort(DEFAULTS)
}

export function start() {
  const server = createServer((_req, res) => {
    res.end('ok')
  })
  server.listen(resolvePort(), DEFAULTS.host)
  return server
}
