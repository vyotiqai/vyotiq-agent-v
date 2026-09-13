import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { setTimeout as delay } from 'node:timers/promises'

const server = new McpServer({ name: 'slow-echo-fixture', version: '1.0.0' })

server.registerTool(
  'slow_echo',
  {
    description: 'Echo after a short delay',
    inputSchema: { message: z.string().describe('Text to echo') }
  },
  async ({ message }) => {
    await delay(1500)
    return {
      content: [{ type: 'text', text: String(message) }]
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
