import { describe, expect, it } from 'vitest'
import { toolCallArgumentsUnusable, wireToolCallArguments } from '@main/agent/toolArgWire'
import { trimDanglingJsonTail } from '@shared/utils/jsonish'

// Regression shapes replayed from real unparseable tool-call payloads
// (scratch/w1-classify.json: 121 unparseable toolCalls across 69 sessions).

describe('trimDanglingJsonTail', () => {
  it('drops a `, "key":` stub whose value never arrived', () => {
    expect(trimDanglingJsonTail('{"a": 1, "b":')).toBe('{"a": 1')
    expect(trimDanglingJsonTail('{"a": 1, "b": ')).toBe('{"a": 1')
  })

  it('drops a `, "key"` stub whose colon and value never arrived', () => {
    expect(trimDanglingJsonTail('{"a": 1, "b"')).toBe('{"a": 1')
  })

  it('drops a bare dangling `,`', () => {
    expect(trimDanglingJsonTail('{"a": 1,')).toBe('{"a": 1')
    expect(trimDanglingJsonTail('{"a": {"k": 1},')).toBe('{"a": {"k": 1}')
    expect(trimDanglingJsonTail('{"a": {"x": 1}, "y"')).toBe('{"a": {"x": 1}')
  })

  it('treats the , / : as the previous token terminator (12, cannot be a cut 123)', () => {
    expect(trimDanglingJsonTail('{"count": 12,')).toBe('{"count": 12')
    expect(trimDanglingJsonTail('{"count": 12, "next":')).toBe('{"count": 12')
  })

  it('never drops anything once the value has started', () => {
    expect(trimDanglingJsonTail('{"a": "he')).toBeNull()
    expect(trimDanglingJsonTail('{"a": {"k":')).toBeNull()
    expect(trimDanglingJsonTail('{"a": 1, "b": [1')).toBeNull()
  })

  it('never drops a complete array element value', () => {
    expect(trimDanglingJsonTail('["x", "y"')).toBeNull()
  })

  it('drops only the separator after a complete array element', () => {
    expect(trimDanglingJsonTail('{"todos":[{"id":"1"},')).toBe('{"todos":[{"id":"1"}')
  })

  it('does not drop a partially built array element', () => {
    expect(trimDanglingJsonTail('{"todos":[{"id":"1"},{"id":"2"')).toBeNull()
  })

  it('is escaped-quote aware and keeps stray braces in strings intact', () => {
    expect(trimDanglingJsonTail('{"a": "x\\"}", "b":')).toBe('{"a": "x\\"}"')
    expect(trimDanglingJsonTail('{"pattern":"interface\\\\{\\\\}",')).toBe(
      '{"pattern":"interface\\\\{\\\\}"'
    )
  })

  it('drops nothing without an open container or a stub tail', () => {
    expect(trimDanglingJsonTail('{"a": 1}')).toBeNull()
    expect(trimDanglingJsonTail('{"a": 1}, "b":')).toBeNull()
    expect(trimDanglingJsonTail('{"a":')).toBeNull()
    expect(trimDanglingJsonTail('')).toBeNull()
  })
})

describe('wireToolCallArguments — observed payload shapes', () => {
  it('salvages the spawn_agent_instance stub cut right before `sub_tasks` (live 4a5dffa5:23)', () => {
    // Observed raw tail: `"path_scope": \n["…"]\n\n, "sub_tasks":` — the value
    // after `sub_tasks` never arrived; everything before it arrived whole.
    const raw =
      '{"goal": "Build a sourced dossier.", "isolation": "shared", "outcome": "File d.md.", "path_scope": \n["artifacts/d.md"]\n\n, "sub_tasks":'
    expect(JSON.parse(wireToolCallArguments('spawn_agent_instance', raw))).toEqual({
      goal: 'Build a sourced dossier.',
      isolation: 'shared',
      outcome: 'File d.md.',
      path_scope: ['artifacts/d.md']
    })
    expect(toolCallArgumentsUnusable('spawn_agent_instance', raw)).toBe(false)
  })

  it('salvages the create_plan stub cut right before optional `todos` (live eebf60a0:136)', () => {
    const raw = '{"title": "Settings Reorg", "plan": "## Goal\\nFinish.", "todos":'
    expect(JSON.parse(wireToolCallArguments('create_plan', raw))).toEqual({
      title: 'Settings Reorg',
      plan: '## Goal\nFinish.'
    })
  })

  it('gates dangling stubs off for write-family tools (locked rationale)', () => {
    const stub = '{"path":"a.ts","new_string":"x","old_string":'
    expect(wireToolCallArguments('str_replace', stub)).toBe('{}')
    expect(toolCallArgumentsUnusable('str_replace', stub)).toBe(true)
    expect(wireToolCallArguments('memory_write', '{"path":"index.md","contents":')).toBe('{}')
    expect(wireToolCallArguments('edit', '{"path":"a.ts","contents":"full body", "diff":')).toBe(
      '{}'
    )
  })

  it('keeps mid-string cuts refused for every tool (by design)', () => {
    // EOF landed inside the body value — closing the string would fabricate a
    // terminator and hand the tool a half-streamed body/URL/plan.
    expect(wireToolCallArguments('str_replace', '{"path":"a.ts","new_string":"partia')).toBe('{}')
    expect(
      wireToolCallArguments('spawn_agent_instance', '{"goal": "Build a dossier...Alibaba/Q')
    ).toBe('{}')
    expect(wireToolCallArguments('create_plan', '{"plan": "# GLM vs Qwen ... multim')).toBe('{}')
    expect(
      wireToolCallArguments('browser_navigate', '{"tab_id": "t3", "url": "https://benchlm.ai/models/glm-5-3-flash')
    ).toBe('{}')
  })

  it('still closes a cut after a complete value for non-write tools', () => {
    expect(
      JSON.parse(wireToolCallArguments('spawn_agent_instance', '{"goal": "Research limits"'))
    ).toEqual({ goal: 'Research limits' })
  })

  it('toolCallArgumentsUnusable is false for empty and {} args', () => {
    expect(toolCallArgumentsUnusable('read', undefined)).toBe(false)
    expect(toolCallArgumentsUnusable('read', '')).toBe(false)
    expect(toolCallArgumentsUnusable('read', '{}')).toBe(false)
    expect(toolCallArgumentsUnusable('read', 'not-json')).toBe(true)
  })
})
