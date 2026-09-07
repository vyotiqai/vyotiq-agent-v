import { describe, expect, it } from 'vitest'
import {
  inferFileWriteAction,
  isUnresolvedToolName,
  summarizeToolArgs
} from '@shared/utils/toolSummary'

describe('toolSummary', () => {
  it('never leaks raw JSON into summaries', () => {
    const summary = summarizeToolArgs(
      'terminal',
      JSON.stringify({ command: 'type C:\\\\Users\\\\foo\\\\bar.txt' })
    )
    expect(summary).not.toContain('{')
    expect(summary).toContain('bar.txt')
  })

  it('sanitizes quoted paths in summaries', () => {
    const summary = summarizeToolArgs(
      'read',
      JSON.stringify({ path: 'C:\\Users\\"youtube tools"\\app.tsx' })
    )
    expect(summary).not.toContain('"')
    expect(summary).toContain('app.tsx')
  })

  it('does not invent a Tool subtitle for unresolved streaming names', () => {
    expect(isUnresolvedToolName('tool')).toBe(true)
    expect(isUnresolvedToolName('')).toBe(true)
    expect(isUnresolvedToolName('todo_write')).toBe(false)
    const summary = summarizeToolArgs(
      'tool',
      JSON.stringify({
        todos: [{ id: '1', content: 'Audit Auth', status: 'in_progress' }]
      })
    )
    expect(summary).toBe('')
  })

  it('summarizes mcp_list_tools with serverId or deprecated server_id', () => {
    expect(
      summarizeToolArgs('mcp_list_tools', JSON.stringify({ serverId: 'github' }))
    ).toContain('github')
    expect(
      summarizeToolArgs('mcp_list_tools', JSON.stringify({ server_id: 'linear' }))
    ).toContain('linear')
    expect(summarizeToolArgs('mcp_list_tools', '{}')).toBe('mcp')
  })

  it('summarizes browser_search with query as target', () => {
    expect(
      summarizeToolArgs('browser_search', JSON.stringify({ query: 'vyotiq agent browser' }))
    ).toBe('vyotiq agent browser')
  })

  it('summarizes browser hover and dialog actions with their targets', () => {
    expect(summarizeToolArgs('browser_hover', JSON.stringify({ selector: '#menu' }))).toBe('#menu')
    expect(summarizeToolArgs('browser_handle_dialog', JSON.stringify({ action: 'dismiss' }))).toBe(
      'dismiss'
    )
  })

  it('does not use done-verb as edit target while args stream', () => {
    expect(summarizeToolArgs('edit', '{')).toBe('')
    expect(summarizeToolArgs('edit', '{"path":')).toBe('')
    expect(summarizeToolArgs('edit', '{}')).toBe('')
    expect(summarizeToolArgs('str_replace', '{"path":"js/game.js"}')).toContain('game.js')
  })

  it('summarizes bare todo_write arrays', () => {
    expect(
      summarizeToolArgs(
        'todo_write',
        JSON.stringify([{ id: '1', content: 'Verify the fix', status: 'completed' }])
      )
    ).toBe('1 task')
    expect(
      summarizeToolArgs(
        'todo_write',
        JSON.stringify({
          todos: [
            { id: '1', content: 'One', status: 'pending' },
            { id: '2', content: 'Two', status: 'pending' }
          ]
        })
      )
    ).toBe('2 tasks')
  })

  it('summarizes ask_question prompts, question alias, and bare arrays', () => {
    expect(
      summarizeToolArgs(
        'ask_question',
        JSON.stringify({
          questions: [{ id: 'q1', prompt: 'Ship it?', type: 'boolean' }]
        })
      )
    ).toBe('Ship it?')
    expect(
      summarizeToolArgs(
        'ask_question',
        JSON.stringify({
          questions: [{ id: 'q1', question: 'Alias prompt?', type: 'text' }]
        })
      )
    ).toBe('Alias prompt?')
    expect(
      summarizeToolArgs('ask_question', JSON.stringify({ prompt: 'Top-level prompt?' }))
    ).toBe('Top-level prompt?')
    expect(
      summarizeToolArgs(
        'ask_question',
        JSON.stringify([{ id: 'q1', prompt: 'Bare array?', type: 'boolean' }])
      )
    ).toBe('Bare array?')
    const unclosed = JSON.stringify([
      { id: 'q1', prompt: 'Unclosed prompt?', type: 'boolean' }
    ]).slice(0, -1)
    expect(
      summarizeToolArgs('ask_question', JSON.stringify({ questions: unclosed }))
    ).toBe('Unclosed prompt?')
  })

  it('summarizes inline agent instance tools with path scope or run id', () => {
    expect(
      summarizeToolArgs(
        'spawn_agent_instance',
        JSON.stringify({
          goal: 'Audit src/agent',
          path_scope: ['src/agent/', 'src/tools/']
        })
      )
    ).toContain('src/agent')
    expect(
      summarizeToolArgs(
        'await_agent_instance',
        JSON.stringify({ run_id: '584c0a1c-434a-4ddf-85c5-a05bb80fd696' })
      )
    ).toBe('584c0a1c')
    expect(
      summarizeToolArgs(
        'pull_agent_instance',
        JSON.stringify({ run_id: '584c0a1c-434a-4ddf-85c5-a05bb80fd696', view: 'outline' })
      )
    ).toBe('584c0a1c')
    expect(
      summarizeToolArgs(
        'merge_agent_instance',
        JSON.stringify({ run_id: '584c0a1c-434a-4ddf-85c5-a05bb80fd696' })
      )
    ).toBe('584c0a1c')
  })

  it('infers created vs modified from edit result text', () => {
    expect(inferFileWriteAction('edit', 'Created src/a.ts (12 chars)')).toBe('created')
    expect(inferFileWriteAction('edit', 'created src/a.ts (12 chars)')).toBe('created')
    expect(inferFileWriteAction('edit', 'Wrote src/a.ts (12 chars)')).toBe('modified')
    expect(inferFileWriteAction('edit', 'Applied diff to src/a.ts')).toBe('modified')
    expect(inferFileWriteAction('edit', '')).toBe(null)
    expect(inferFileWriteAction('edit', 'Cancelled')).toBe(null)
    expect(inferFileWriteAction('str_replace', 'Created src/a.ts (12 chars)')).toBe(null)
  })
})
