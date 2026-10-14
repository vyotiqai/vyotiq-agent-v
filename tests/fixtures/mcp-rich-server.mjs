import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

/**
 * Paged lists (two pages each), binary tool content, and a tool that adds a
 * tool and announces it with `notifications/tools/list_changed`.
 */
const server = new Server(
  { name: 'rich', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } }
)
const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })
let grown = false
server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  if (req.params?.cursor === 'page2') {
    return { tools: [tool('second_page_tool'), ...(grown ? [tool('late_tool')] : [])] }
  }
  return { tools: [tool('first_page_tool'), tool('screenshot'), tool('grow')], nextCursor: 'page2' }
})
server.setRequestHandler(ListResourcesRequestSchema, async (req) =>
  req.params?.cursor === 'r2'
    ? { resources: [{ uri: 'file:///second.txt', name: 'second' }] }
    : { resources: [{ uri: 'file:///first.txt', name: 'first' }], nextCursor: 'r2' }
)
server.setRequestHandler(ListPromptsRequestSchema, async (req) =>
  req.params?.cursor === 'p2'
    ? { prompts: [{ name: 'second_prompt' }] }
    : { prompts: [{ name: 'first_prompt' }], nextCursor: 'p2' }
)
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'screenshot') {
    return {
      content: [
        { type: 'text', text: 'Screenshot taken' },
        { type: 'image', mimeType: 'image/png', data: Buffer.alloc(300_000, 7).toString('base64') }
      ]
    }
  }
  if (req.params.name === 'grow') {
    grown = true
    await server.sendToolListChanged()
    return { content: [{ type: 'text', text: 'grown' }] }
  }
  return { content: [{ type: 'text', text: 'ok' }] }
})
await server.connect(new StdioServerTransport())
