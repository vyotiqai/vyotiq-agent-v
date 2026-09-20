import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

/**
 * MCP puts no constraints on tool names, but the model APIs do. This server
 * exposes names a real one legitimately could, to prove the bad ones are
 * dropped before they reach a provider instead of 400-ing the whole request.
 */
const server = new McpServer({ name: 'odd-names-fixture', version: '1.0.0' })

server.registerTool(
  'fine_tool',
  { description: 'Ordinary name', inputSchema: { message: z.string() } },
  async ({ message }) => ({ content: [{ type: 'text', text: String(message) }] })
)

// A dot is outside the `[A-Za-z0-9_-]` every provider allows.
server.registerTool(
  'dotted.name',
  { description: 'Dot in the name', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'dotted' }] })
)

// Prefix + server id + this is comfortably past the 128-character cap.
server.registerTool(
  `very_long_${'x'.repeat(140)}`,
  { description: 'Name past every length cap', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'long' }] })
)

const transport = new StdioServerTransport()
await server.connect(transport)
