import { describe, expect, it } from 'vitest'

import { mapToolGroupProps } from '@renderer/features/chat/utils/toolGroupAdapter'

import type { UiToolRow } from '@shared/transcript'



function tool(

  id: string,

  name: string,

  summary: string,

  status: UiToolRow['status'] = 'done',

  content?: string

): UiToolRow {

  return { id, name, summary, status, content }

}



describe('mapToolGroupProps', () => {

  it('maps pending state when group is open and tools are running', () => {

    const result = mapToolGroupProps(

      [tool('t1', 'read', 'src/a.ts', 'running'), tool('t2', 'search', 'query', 'running')],

      { groupTiming: { startedAt: 1_000 } }

    )

    expect(result.state).toBe('pending')

    expect(result.nestedTools).toHaveLength(2)

    expect(result.nestedTools[0]?.category).toBe('file')

    expect(result.nestedTools[1]?.category).toBe('search')

    expect(result.summary).toBe('1 file and 1 lookup')

  })



  it('maps completed state when group timing is closed', () => {

    const result = mapToolGroupProps(

      [

        tool('t1', 'read', 'src/a.ts'),

        tool('t2', 'terminal', 'pnpm test'),

        tool('t3', 'search', 'foo')

      ],

      { groupTiming: { startedAt: 1_000, endedAt: 7_000 } }

    )

    expect(result.state).toBe('completed')

    expect(result.summary).toBe('1 file, 1 lookup, and 1 command')

    expect(result.elapsedDisplay).toBe('6s')

  })



  it('completes a finished group whose timing is still open', () => {

    const result = mapToolGroupProps([tool('t1', 'read', 'src/a.ts'), tool('t2', 'search', 'q')], {

      groupTiming: { startedAt: 1_000 }

    })

    expect(result.state).toBe('completed')

  })



  it('maps interrupted state from cancelled tool content', () => {
    const result = mapToolGroupProps(
      [tool('t1', 'read', 'src/a.ts', 'fail', 'Cancelled')],
      { groupTiming: { startedAt: 1_000, endedAt: 2_000 } }
    )
    expect(result.state).toBe('interrupted')
    expect(result.doneLabel).toBe('Reading')
    expect(result.nestedTools[0]?.title).toBe('Reading')
    expect(result.nestedTools[0]?.subtitle).toMatch(/a\.ts/)
  })

  it('uses Asking not Asked for interrupted ask_question', () => {
    const result = mapToolGroupProps(
      [tool('t1', 'ask_question', 'Should I continue?', 'fail', 'Cancelled')],
      { groupTiming: { startedAt: 1_000, endedAt: 2_000 } }
    )
    expect(result.state).toBe('interrupted')
    expect(result.doneLabel).toBe('Asking')
    expect(result.nestedTools[0]?.title).toBe('Asking')
  })

  it('maps MCP list tools to browse category with path-only nested title', () => {

    const result = mapToolGroupProps(

      [

        tool('t1', 'mcp__github__list_issues', 'vyotiq', 'done'),

        tool('t2', 'mcp__github__list_labels', 'repo', 'done')

      ],

      { groupTiming: { startedAt: 1_000, endedAt: 2_000 } }

    )

    expect(result.nestedTools[0]?.category).toBe('browse')

    expect(result.nestedTools[0]?.title).toBe('vyotiq')

    expect(result.nestedTools[0]?.subtitle).toBe('')

  })



  it('uses basename for file tool subtitles', () => {

    const result = mapToolGroupProps([tool('t1', 'read', 'src/components/Chat.tsx')], {

      groupTiming: { startedAt: 1_000, endedAt: 2_000 }

    })

    expect(result.nestedTools[0]?.subtitle).toBe('Chat.tsx')

  })



  it('shows the line range a ranged read asked for', () => {

    const row = tool('t1', 'read', 'src/app.css')

    row.argsPreview = JSON.stringify({ path: 'src/app.css', startLine: 12, endLine: 48 })

    const result = mapToolGroupProps([row], { groupTiming: { startedAt: 1 } })

    expect(result.nestedTools[0]?.subtitle).toBe('app.css L12-48')

  })



  it('marks an open-ended read range rather than inventing its end', () => {

    const row = tool('t1', 'read', 'src/app.css')

    row.argsPreview = JSON.stringify({ startLine: 12 })

    const result = mapToolGroupProps([row], { groupTiming: { startedAt: 1 } })

    expect(result.nestedTools[0]?.subtitle).toBe('app.css L12+')

  })



  it('derives the range from the text when a whole file came back', () => {

    const row = tool('t1', 'read', 'a.css', 'done', 'one\ntwo\nthree\n')

    const result = mapToolGroupProps([row], { groupTiming: { startedAt: 1 } })

    expect(result.nestedTools[0]?.subtitle).toBe('a.css L1-3')

  })



  it('stays silent about the range when only a preview arrived', () => {

    const row = tool('t1', 'read', 'a.css', 'done', 'one\ntwo')

    row.contentTruncated = true

    const result = mapToolGroupProps([row], { groupTiming: { startedAt: 1 } })

    expect(result.nestedTools[0]?.subtitle).toBe('a.css')

  })

  it('uses short ids instead of protocol labels for instance subtitles', () => {
    const spawn = tool(
      's1',
      'spawn_agent_instance',
      'Agent V Instance id; 584c0a1c-434a-4ddf-85c5-a05bb80fd696',
      'done',
      'Agent V Instance id; 584c0a1c-434a-4ddf-85c5-a05bb80fd696\nrun_id: 584c0a1c-434a-4ddf-85c5-a05bb80fd696'
    )
    const awaitTool = tool('a1', 'await_agent_instance', 'await', 'running')
    awaitTool.argsPreview = JSON.stringify({
      run_id: '7f2e9b1a-1111-2222-3333-444455556666'
    })

    expect(mapToolGroupProps([spawn], { groupTiming: { startedAt: 1 } }).nestedTools[0]?.subtitle).toBe(
      '584c0a1c'
    )
    expect(
      mapToolGroupProps([awaitTool], { groupTiming: { startedAt: 1 } }).nestedTools[0]?.subtitle
    ).toBe('7f2e9b1a')
  })

  it('uses composite verbs for mixed-category groups', () => {
    const result = mapToolGroupProps(
      [
        tool('t1', 'read', 'src/a.ts'),
        tool('t2', 'list_dir', '.'),
        tool('t3', 'list_dir', 'src')
      ],
      { groupTiming: { startedAt: 1_000, endedAt: 2_000 } }
    )

    expect(result.doneLabel).toBe('Read and listed')
    expect(result.summary).toBe('1 file and 2 directories')
  })

  it('keeps a directory listing action distinct from a later file read', () => {
    const result = mapToolGroupProps(
      [tool('t1', 'list_dir', 'src'), tool('t2', 'read', 'src/package.json')],
      { groupTiming: { startedAt: 1_000, endedAt: 2_000 } }
    )

    expect(result.nestedTools[0]?.title).toBe('Listed')
    expect(result.nestedTools[0]?.subtitle).toBe('src')
    expect(result.nestedTools[1]?.title).toBe('package.json')
  })

  it('collapses duplicate listing verbs for directory and memory listings', () => {
    const result = mapToolGroupProps(
      [tool('t1', 'list_dir', '.'), tool('t2', 'memory_list', '.vyotiq/memory')],
      { groupTiming: { startedAt: 1_000, endedAt: 2_000 } }
    )

    expect(result.doneLabel).toBe('Listed')
    expect(result.runningLabel).toBe('Listing')
    expect(result.summary).toBe('1 directory and 1 memory listing')
    expect(result.doneLabel).not.toMatch(/listed memory/i)
  })

  it('uses Exploring for three-or-more category mixes', () => {
    const result = mapToolGroupProps(
      [
        tool('t1', 'list_dir', '.'),
        tool('t2', 'terminal', 'pnpm test'),
        tool('t3', 'edit', 'src/a.ts')
      ],
      { groupTiming: { startedAt: 1_000 } }
    )

    expect(result.runningLabel).toBe('Exploring')
    expect(result.doneLabel).toBe('Explored')
    expect(result.summary).toBe('1 edit, 1 command, and 1 directory')
  })

  it('shows a preparing label for unresolved streaming tool rows in a group', () => {
    const result = mapToolGroupProps(
      [tool('t1', 'tool', '', 'running')],
      { groupTiming: { startedAt: 1_000 } }
    )

    expect(result.nestedTools[0]?.title).toBe('Preparing…')
  })

  it('keeps Preparing even when unresolved rows already have streaming args', () => {
    const row = tool('t1', 'tool', 'Tool', 'running')
    row.argsPreview = JSON.stringify({
      todos: [{ id: 'audit-1', content: 'Audit Auth', status: 'in_progress' }]
    })
    const result = mapToolGroupProps([row], { groupTiming: { startedAt: 1_000 } })

    expect(result.nestedTools[0]?.title).toBe('Preparing…')
    expect(result.nestedTools[0]?.subtitle).toBe('')
  })

  it('does not count unresolved tools as files under Preparing', () => {
    const result = mapToolGroupProps(
      [tool('t1', 'tool', '', 'running'), tool('t2', 'tool', '', 'running')],
      { groupTiming: { startedAt: 1_000 } }
    )

    expect(result.runningLabel).toBe('Preparing…')
    expect(result.summary).toBe('')
    expect(result.nestedTools.every((row) => row.title === '')).toBe(true)
  })

  it('does not title unknown tools with args.path placeholder (T1/E3)', () => {
    const result = mapToolGroupProps(
      [
        tool('d1', 'delete', '.sv.js', 'done', 'Deleted .sv.js'),
        tool(
          'w1',
          'write_file_check',
          'placeholder',
          'fail',
          'Unknown tool "write_file_check". Use edit or str_replace to change files.'
        )
      ],
      { groupTiming: { startedAt: 1_000 } }
    )
    const unknown = result.nestedTools.find((row) => row.name === 'write_file_check')
    expect(unknown?.title).not.toBe('placeholder')
    expect(unknown?.title.toLowerCase()).toContain('write')
    expect(unknown?.subtitle).toBe('')
  })

  it('does not use … subtitle for ask_question with empty summary (E1)', () => {
    const result = mapToolGroupProps(
      [
        tool(
          'a1',
          'ask_question',
          '',
          'fail',
          'questions: Expected array, received string'
        )
      ],
      { groupTiming: { startedAt: 1_000 } }
    )
    expect(result.nestedTools[0]?.subtitle).toBe('')
    expect(result.nestedTools[0]?.title).not.toContain('…')
  })

  it('does not title a failed ask_question with its raw tool id', () => {
    const result = mapToolGroupProps(
      [
        tool('d1', 'delete', '.sv.js', 'done', 'Deleted .sv.js'),
        tool(
          'a1',
          'ask_question',
          'ask_question',
          'fail',
          'ask_question.questions must be a JSON array of question objects.'
        )
      ],
      { groupTiming: { startedAt: 1_000 } }
    )
    const ask = result.nestedTools.find((row) => row.name === 'ask_question')
    expect(ask?.title).toBe('Failed')
  })

  it('labels a group of new-file edits as Created', () => {
    const result = mapToolGroupProps(
      [
        tool('t1', 'edit', 'a.ts', 'done', 'Created a.ts (3 chars)'),
        tool('t2', 'edit', 'b.ts', 'done', 'Created b.ts (3 chars)')
      ],
      { groupTiming: { startedAt: 1_000 } }
    )
    expect(result.doneLabel).toBe('Created')
  })

  it('keeps Edited when a same-tool group mixes create and modify', () => {
    const result = mapToolGroupProps(
      [
        tool('t1', 'edit', 'a.ts', 'done', 'Created a.ts (3 chars)'),
        tool('t2', 'edit', 'b.ts', 'done', 'Wrote b.ts (3 chars)')
      ],
      { groupTiming: { startedAt: 1_000 } }
    )
    expect(result.doneLabel).toBe('Edited')
  })
})

