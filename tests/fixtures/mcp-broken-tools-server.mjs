import { writeFileSync } from 'fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/**
 * Connects fine, then fails `tools/list`: MCP_FIXTURE_TOOLS=error answers with an
 * internal error, MCP_FIXTURE_TOOLS=hang never answers.
 */
if (process.env.MCP_FIXTURE_PID_FILE) writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid))
const server = new Server({ name: 'broken-tools', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (process.env.MCP_FIXTURE_TOOLS === 'hang') return new Promise(() => {})
  throw new Error('tools/list exploded')
})
await server.connect(new StdioServerTransport())
