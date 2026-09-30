import { describe, expect, it } from 'vitest'
import { recoverTextToolCalls } from '@main/agent/textToolCalls'
import { stripToolShapedAssistantText } from '@shared/domain/transcript'

const offered = new Set(['read', 'grep', 'terminal'])
const args = (call: { arguments: string }) => JSON.parse(call.arguments) as unknown

describe('recoverTextToolCalls', () => {
  it('recovers Qwen/Hermes <tool_call> blocks and keeps the prose', () => {
    const got = recoverTextToolCalls(
      'Let me look.\n<tool_call>\n{"name": "read", "arguments": {"path": "a.ts"}}\n</tool_call>\n<tool_call>{"name":"grep","arguments":"{\\"pattern\\":\\"x\\"}"}</tool_call>',
      offered
    )
    expect(got?.calls.map((c) => [c.name, args(c)])).toEqual([
      ['read', { path: 'a.ts' }],
      ['grep', { pattern: 'x' }]
    ])
    expect(got?.text).toBe('Let me look.')
  })

  it('recovers an unterminated <tool_call> at the end of the reply', () => {
    const got = recoverTextToolCalls('<tool_call>{"name":"read","arguments":{"path":"b.ts"}}', offered)
    expect(got?.calls).toEqual([{ name: 'read', arguments: '{"path":"b.ts"}' }])
    expect(got?.text).toBe('')
  })

  it('recovers both Mistral forms', () => {
    const older = recoverTextToolCalls('[TOOL_CALLS][{"name":"read","arguments":{"path":"c.ts"}}]', offered)
    expect(older?.calls.map((c) => c.name)).toEqual(['read'])
    const newer = recoverTextToolCalls('[TOOL_CALLS]terminal[ARGS]{"command":"ls"}', offered)
    expect(newer?.calls.map((c) => [c.name, args(c)])).toEqual([['terminal', { command: 'ls' }]])
  })

  it('recovers Llama <|python_tag|> and <function=…> forms', () => {
    const tag = recoverTextToolCalls('<|python_tag|>{"name": "read", "parameters": {"path": "d.ts"}}<|eom_id|>', offered)
    expect(tag?.calls.map((c) => [c.name, args(c)])).toEqual([['read', { path: 'd.ts' }]])
    const fn = recoverTextToolCalls('<function=grep>{"pattern": "TODO"}</function>', offered)
    expect(fn?.calls.map((c) => [c.name, args(c)])).toEqual([['grep', { pattern: 'TODO' }]])
  })

  it('recovers a reply that is only a JSON call, bare or fenced', () => {
    const bare = recoverTextToolCalls('{"name": "read", "arguments": {"path": "e.ts"}}', offered)
    expect(bare?.calls.map((c) => c.name)).toEqual(['read'])
    const fenced = recoverTextToolCalls('```json\n{"type":"function","function":{"name":"read","arguments":{"path":"f.ts"}}}\n```', offered)
    expect(fenced?.calls.map((c) => [c.name, args(c)])).toEqual([['read', { path: 'f.ts' }]])
  })

  it('leaves explanations, unknown tools and malformed JSON alone', () => {
    const explaining =
      'To read a file you would call the read tool. It takes a path, like this:\n```json\n{"name": "read", "arguments": {"path": "g.ts"}}\n```\nThat returns the file with line numbers, and you can then grep for what you need across the whole workspace.'
    expect(recoverTextToolCalls(explaining, offered)).toBeNull()
    expect(recoverTextToolCalls('<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>', offered)).toBeNull()
    expect(recoverTextToolCalls('<tool_call>{"name":"read", "arguments": {path}}</tool_call>', offered)).toBeNull()
    expect(recoverTextToolCalls('Here is the answer: 42.', offered)).toBeNull()
    expect(recoverTextToolCalls('<tool_call>{"name":"read","arguments":{}}</tool_call>', new Set())).toBeNull()
  })

  it('maps an alias to the offered name', () => {
    const got = recoverTextToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"h.ts"}}</tool_call>', offered, (n) =>
      n === 'read_file' ? 'read' : n
    )
    expect(got?.calls.map((c) => c.name)).toEqual(['read'])
  })
})

describe('template tool-call syntax in the transcript', () => {
  it('is never shown as text', () => {
    expect(stripToolShapedAssistantText('Checking.\n<tool_call>{"name":"read","arguments":{}}</tool_call>')).toBe('Checking.')
    expect(stripToolShapedAssistantText('[TOOL_CALLS][{"name":"read"}]')).toBe('')
    expect(stripToolShapedAssistantText('Plain answer with <b>html</b>.')).toBe('Plain answer with <b>html</b>.')
  })
})
