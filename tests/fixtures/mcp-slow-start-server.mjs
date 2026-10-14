import { appendFileSync } from 'fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

/**
 * Takes MCP_FIXTURE_DELAY_MS before answering `initialize`, like a cold npx/uvx
 * start. MCP_FIXTURE_LOG gets a `start <ms>` line on launch and a `ready <ms>`
 * line once it can answer, so a test can tell overlapping connects from serial ones.
 */
const log = (what) => {
  if (process.env.MCP_FIXTURE_LOG) appendFileSync(process.env.MCP_FIXTURE_LOG, `${what} ${Date.now()}\n`)
}
log('start')
await new Promise((r) => setTimeout(r, Number(process.env.MCP_FIXTURE_DELAY_MS ?? 1500)))
const server = new McpServer({ name: 'slow-start', version: '1.0.0' })
server.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'pong' }]
}))
await server.connect(new StdioServerTransport())
log('ready')
