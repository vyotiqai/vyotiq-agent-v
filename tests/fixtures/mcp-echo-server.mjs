import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' })

server.registerTool(
  'echo',
  {
    description: 'Echo a message back to the caller',
    inputSchema: { message: z.string().describe('Text to echo') }
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: String(message) }]
  })
)

const transport = new StdioServerTransport()
await server.connect(transport)
