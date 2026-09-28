import { describe, expect, it } from 'vitest'
import {
  agentToolSchemaProblems,
  normalizeAgentToolSchema
} from '@main/agent/agentTools/schema'

// The three shapes found in a real agent-tools dir (2026-09-28). Any one of
// them in the tool list made MiMo (OpenCode Go) 400 every request with
// "Invalid request parameters", even for a bare "hi".
const RUN = {
  type: 'object',
  properties: {
    argv: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string' },
    timeoutMs: { type: 'integer' }
  },
  maxChars: { type: 'integer', description: 'Cap stdout+stderr returned' },
  required: { item: { item: 'argv' } }
}
const SH = { ...RUN, required: { item: 'argv' } }
const DL = {
  type: 'object',
  properties: { url: { type: 'string' }, dest: { type: 'string' } },
  required: { item: ['url', 'dest'] }
}

describe('agent-built tool schema checks', () => {
  it('returns a well-formed schema as the same object', () => {
    const ok = {
      type: 'object',
      properties: { a: { type: 'number' } },
      required: ['a'],
      additionalProperties: false
    }
    expect(agentToolSchemaProblems(ok)).toEqual([])
    expect(normalizeAgentToolSchema(ok)).toBe(ok)
    const bare = { type: 'object' }
    expect(normalizeAgentToolSchema(bare)).toBe(bare)
  })

  it('unwraps required and moves stray root properties inside', () => {
    expect(normalizeAgentToolSchema(RUN)).toEqual({
      type: 'object',
      properties: { ...RUN.properties, maxChars: RUN.maxChars },
      required: ['argv']
    })
    expect(normalizeAgentToolSchema(SH).required).toEqual(['argv'])
    expect(normalizeAgentToolSchema(DL)).toEqual({ ...DL, required: ['url', 'dest'] })
  })

  it('drops required names that are not properties, and unknown root keys', () => {
    const out = normalizeAgentToolSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a', 'ghost'],
      examples: [{ a: 'x' }]
    })
    expect(out).toEqual({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })
  })

  it('names each problem so build_tool can say what to fix', () => {
    const problems = agentToolSchemaProblems(RUN)
    expect(problems.some((p) => p.startsWith('required must be an array'))).toBe(true)
    expect(problems.some((p) => p.includes('"maxChars" sits at the schema root'))).toBe(true)
    expect(agentToolSchemaProblems({ type: 'string' })[0]).toMatch(/type must be "object"/)
  })
})
