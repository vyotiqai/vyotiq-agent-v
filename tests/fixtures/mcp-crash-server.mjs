import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

/**
 * Fixture for MCP session-recovery tests: a server that can be made to die the
 * two ways a real one does — cleanly after answering, and mid-request.
 */
const server = new McpServer({ name: 'crash-fixture', version: '1.0.0' })

server.registerTool(
  'echo',
  { description: 'Echo a message back', inputSchema: { message: z.string() } },
  async ({ message }) => ({ content: [{ type: 'text', text: String(message) }] })
)

/** Answers normally, then the child exits — a crash the app never gets told about. */
server.registerTool(
  'die_after_reply',
  { description: 'Reply, then exit', inputSchema: {} },
  async () => {
    setTimeout(() => process.exit(0), 50)
    return { content: [{ type: 'text', text: 'bye' }] }
  }
)

/** Exits without replying, so the in-flight request dies with the transport. */
server.registerTool(
  'die_during_call',
  { description: 'Exit without replying', inputSchema: {} },
  async () => {
    process.exit(0)
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
