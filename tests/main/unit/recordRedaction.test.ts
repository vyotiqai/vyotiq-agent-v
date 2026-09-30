import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/ipc'
import { redactForRecord } from '@main/agent/recordRedaction'
import { REDACTED_SECRET } from '@shared/utils/redactSecrets'

const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345'
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nAAAA\n-----END RSA PRIVATE KEY-----'

describe('redactForRecord', () => {
  it('redacts text, text parts, attached file text, thinking and tool-call arguments, and keeps arguments valid JSON', () => {
    const message: ChatMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: `The key is ${KEY}` },
        { type: 'file', name: '.env', mime: 'text/plain', text: `OPENAI_API_KEY=${KEY}` },
        { type: 'image_url', url: 'data:image/png;base64,sk-proj-abcdefghijklmnopqrstuvwxyz0123' }
      ],
      thinking: `I should not echo ${KEY}`,
      toolCalls: [
        { id: 't1', name: 'write', arguments: JSON.stringify({ path: 'id_rsa', content: PEM }) },
        { id: 't2', name: 'terminal', arguments: JSON.stringify({ command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstu" x' }) }
      ],
      reasoningState: { kind: 'anthropic', blocks: [{ type: 'thinking', thinking: KEY }] }
    }
    const record = redactForRecord(message)
    // Everything but the opaque fields (attachment bytes, signed reasoning) is clean.
    const { reasoningState: _opaque, ...rest } = record
    void _opaque
    const text = JSON.stringify({ ...rest, content: (rest.content as Array<{ type: string }>).filter((p) => p.type !== 'image_url') })
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz012345')
    const parts = record.content as Array<Record<string, string>>
    expect(parts[0]!.text).toBe(`The key is ${REDACTED_SECRET}`)
    expect(parts[1]!.text).toBe(`OPENAI_API_KEY=${REDACTED_SECRET}`)
    // Attachment bytes and signed reasoning are opaque: untouched.
    expect(parts[2]!.url).toContain('sk-proj-')
    expect(record.reasoningState).toBe(message.reasoningState)
    expect(record.thinking).toBe(`I should not echo ${REDACTED_SECRET}`)
    expect(JSON.parse(record.toolCalls![0]!.arguments)).toEqual({ path: 'id_rsa', content: REDACTED_SECRET })
    expect(JSON.parse(record.toolCalls![1]!.arguments).command).toContain(`Bearer ${REDACTED_SECRET}`)

    // The object the run holds in memory is never changed.
    expect((message.content as Array<Record<string, string>>)[0]!.text).toContain(KEY)
    expect(message.toolCalls![0]!.arguments).toContain('BEGIN RSA PRIVATE KEY')
  })

  it('returns the same object when there is nothing to redact', () => {
    const message: ChatMessage = { role: 'tool', toolCallId: 't', content: 'const token: string = read()' }
    expect(redactForRecord(message)).toBe(message)
    const event = { type: 'tool_start', summary: 'ls -la', args: { path: 'src' } }
    expect(redactForRecord(event)).toBe(event)
  })

  it('redacts a token in a link but leaves data URIs whole', () => {
    const event = {
      type: 'tool_start',
      args: { url: `https://api.example.com/v1?key=${KEY}` },
      image: { url: `data:image/png;base64,${KEY}` }
    }
    const record = redactForRecord(event)
    expect(record.args.url).toBe(`https://api.example.com/v1?key=${REDACTED_SECRET}`)
    expect(record.image).toBe(event.image)
  })

  it('redacts nested event text such as follow-ups and tool summaries', () => {
    const event = {
      type: 'follow_up_applied',
      messages: [{ role: 'user', content: `use ${KEY}` }],
      summary: 'export GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'
    }
    const record = redactForRecord(event)
    expect(record.messages[0]!.content).toBe(`use ${REDACTED_SECRET}`)
    expect(record.summary).toBe(`export GITHUB_TOKEN=${REDACTED_SECRET}`)
    expect(event.messages[0]!.content).toContain(KEY)
  })
})
