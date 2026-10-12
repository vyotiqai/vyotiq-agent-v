// A stdio MCP server that asks the client for input mid-call (elicitation)
// and grows its tool list at runtime (tools/list_changed).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'elicit-fixture', version: '1.0.0' })

server.registerTool('book', { description: 'Book a table, asking for the details' }, async () => {
  const result = await server.server.elicitInput({
    message: 'Book a table?',
    requestedSchema: {
      type: 'object',
      properties: {
        guests: { type: 'integer', title: 'Guests', minimum: 1, maximum: 8 },
        seating: { type: 'string', title: 'Seating', oneOf: [{ const: 'in', title: 'Inside' }, { const: 'out', title: 'Outside' }] }
      },
      required: ['guests']
    }
  })
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
})

for (const [name, url] of [
  ['signin', 'https://example.com/auth?state=1'],
  ['signin-plain', 'http://example.com/auth']
]) {
  server.registerTool(name, { description: 'Ask the person to open a sign-in page' }, async () => {
    const result = await server.server.elicitInput({ mode: 'url', message: 'Sign in to finish booking', url, elicitationId: `${name}-1` })
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  })
}

server.registerTool('summarize', { description: 'Ask the client model for a summary' }, async () => {
  try {
    const result = await server.server.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'Summarize: the table is booked for four.' } }],
      systemPrompt: 'Answer in five words.',
      maxTokens: 50
    })
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: String(err?.message ?? err) }) }] }
  }
})

let grown = false
server.registerTool('grow', { description: 'Add a tool' }, async () => {
  if (!grown) {
    grown = true
    // McpServer announces the new tool with notifications/tools/list_changed.
    server.registerTool('extra', { description: 'Added at runtime', inputSchema: { n: z.number() } }, async ({ n }) => ({
      content: [{ type: 'text', text: String(n * 2) }]
    }))
  }
  return { content: [{ type: 'text', text: 'grown' }] }
})

await server.connect(new StdioServerTransport())
