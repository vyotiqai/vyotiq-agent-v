import { writeFileSync } from 'fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

/** A valid MCP server that offers resources and no tools: `tools/list` answers -32601. */
if (process.env.MCP_FIXTURE_PID_FILE) writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid))
const server = new McpServer({ name: 'resources-only', version: '1.0.0' })
server.registerResource('readme', 'file:///readme.txt', { mimeType: 'text/plain' }, async (uri) => ({
  contents: [{ uri: uri.href, text: 'hello' }]
}))
await server.connect(new StdioServerTransport())
