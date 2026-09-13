import { describe, expect, it } from 'vitest'
import {
  buildTranscriptRows,
  isTurnWorkRow,
  rowLeadingGap,
  stabilizeTranscriptRows,
  transcriptRowFingerprint,
  turnHasVisibleToolWork,
  TURN_GAP_PX,
  type TranscriptRow
} from '@renderer/features/chat/utils/transcriptRows'
import type { UiItem } from '@shared/transcript'

function tool(id: string, name = 'read', expanded = false): UiItem {
  return {
    kind: 'tool',
    id,
    toolExpanded: expanded,
    tool: { id, name, summary: id, status: 'done' }
  }
}

describe('buildTranscriptRows', () => {
  it('keeps inline agent instance tools in individual compact activity rows', () => {
    const spawn = tool('s1', 'spawn_agent_instance')
    spawn.tool.status = 'done'
    const awaitA = tool('a1', 'await_agent_instance')
    awaitA.tool.status = 'running'
    awaitA.toolExpanded = undefined
    awaitA.tool.argsPreview = JSON.stringify({ run_id: '584c0a1c-434a-4ddf-85c5-a05bb80fd696' })
    const awaitB = tool('a2', 'await_agent_instance')
    awaitB.tool.status = 'running'
    awaitB.toolExpanded = undefined
    awaitB.tool.argsPreview = JSON.stringify({ run_id: '7f2e9b1a-1111-2222-3333-444455556666' })
    const pull = tool('p1', 'pull_agent_instance')
    const merge = tool('m1', 'merge_agent_instance')

    const rows = buildTranscriptRows([spawn, awaitA, awaitB, pull, merge])
    expect(rows.map((row) => row.kind)).toEqual([
      'activity',
      'activity',
      'activity',
      'activity',
      'activity'
    ])
    expect(rows.every((row) => row.kind !== 'card')).toBe(true)
    for (const row of rows) {
      if (row.kind === 'activity') expect(row.tools).toHaveLength(1)
    }
    expect(rows[1]?.kind === 'activity' ? rows[1].tools[0]?.toolExpanded : undefined).toBe(false)
    expect(rows[2]?.kind === 'activity' ? rows[2].tools[0]?.toolExpanded : undefined).toBe(false)
  })

  it('assigns turn indices starting from user messages', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'hello' },
      { kind: 'message', id: 'u2', role: 'user', content: 'again' },
      { kind: 'message', id: 'a2', role: 'assistant', content: 'sure' }
    ]
    const rows = buildTranscriptRows(items)
    expect(rows[0]?.kind).toBe('user')
    expect(rows[0]?.turnIndex).toBe(0)
    expect(rows[2]?.kind).toBe('user')
    expect(rows[2]?.turnIndex).toBe(1)
  })

  it('groups consecutive tools into a single activity row', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'm1', role: 'assistant', content: 'go' },
      tool('t1'),
      tool('t2'),
      tool('t3'),
      { kind: 'message', id: 'm2', role: 'assistant', content: 'done' }
    ]
    const rows = buildTranscriptRows(items)
    const activityRows = rows.filter((row) => row.kind === 'activity')
    expect(activityRows).toHaveLength(1)
    if (activityRows[0]?.kind === 'activity') {
      expect(activityRows[0].tools).toHaveLength(3)
    }
  })

  it('does not emit a text row for whitespace-only streaming assistant content after tools', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'search' },
      {
        kind: 'tool',
        id: 't1',
        toolExpanded: false,
        tool: { id: 't1', name: 'web_search', summary: 'Searching', status: 'running' }
      },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: ' \n',
        streaming: true
      }
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.some((row) => row.kind === 'text')).toBe(false)
    expect(rows.some((row) => row.kind === 'activity')).toBe(true)
  })

  it('breaks terminal and edit tools out as cards between lookups', () => {
    const rows = buildTranscriptRows([
      tool('r1', 'read'),
      tool('t1', 'terminal'),
      tool('r2', 'read'),
      tool('e1', 'edit')
    ])
    expect(rows.map((row) => row.kind)).toEqual(['activity', 'card', 'activity', 'card'])
    expect(rows.filter((row) => row.kind === 'activity').map((row) => {
      if (row.kind !== 'activity') return []
      return row.tools.map((item) => item.id)
    })).toEqual([['r1'], ['r2']])
    expect(rows.filter((row) => row.kind === 'card').map((row) => row.id)).toEqual(['t1', 'e1'])
  })

  it('gives a lone terminal call a card row', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'build it' },
      tool('t1', 'terminal'),
      { kind: 'message', id: 'u2', role: 'user', content: 'and read it' },
      tool('r1', 'read')
    ]
    expect(buildTranscriptRows(items).map((row) => row.kind)).toEqual([
      'user',
      'card',
      'turn',
      'user',
      'activity',
      'turn'
    ])
  })

  it('keeps mid-loop narration inline, in the order it happened', () => {
    const items: UiItem[] = [
      tool('a1'),
      { kind: 'message', id: 'm', role: 'assistant', content: 'now the router' },
      tool('b1')
    ]
    expect(buildTranscriptRows(items).map((row) => row.kind)).toEqual([
      'activity',
      'text',
      'activity'
    ])
  })

  it('does not split a tool stretch on assistant rows that render nothing', () => {
    // Splitting there produced a stack of identical group headers with no
    // visible separator between them.
    const items: UiItem[] = [
      tool('a1'),
      tool('a2'),
      { kind: 'message', id: 'm', role: 'assistant', content: '' },
      tool('b1')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('activity')
    if (rows[0]?.kind === 'activity') {
      expect(rows[0].tools.map((item) => item.id)).toEqual(['a1', 'a2', 'b1'])
    }
  })

  it('keeps a command as a card even mid-batch', () => {
    const items: UiItem[] = [
      tool('a1'),
      { kind: 'message', id: 'm', role: 'assistant', content: 'building' },
      tool('t1', 'terminal')
    ]
    expect(buildTranscriptRows(items).map((row) => row.kind)).toEqual([
      'activity',
      'text',
      'card'
    ])
  })

  it('splits a tool stretch across turns', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'first' },
      tool('a1'),
      { kind: 'message', id: 'u2', role: 'user', content: 'second' },
      tool('b1')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((row) => row.kind)).toEqual([
      'user',
      'activity',
      'turn',
      'user',
      'activity',
      'turn'
    ])
  })

  it('times a turn from the prompt to the last thing it produced', () => {
    const readTool = tool('t1')
    readTool.at = '2026-07-25T10:00:05.000Z'
    readTool.groupTiming = { startedAt: 5_000, endedAt: 12_000 }
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go', at: '2026-07-25T10:00:00.000Z' },
      readTool,
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'done',
        at: '2026-07-25T10:00:20.000Z'
      }
    ]
    const summary = buildTranscriptRows(items).find((row) => row.kind === 'turn')
    expect(summary?.kind).toBe('turn')
    if (summary?.kind === 'turn') {
      expect(summary.span.endedAt! - summary.span.startedAt!).toBe(20_000)
      expect(summary.span.active).toBe(false)
    }
  })

  it('times a follow-up turn from the hydrated prompt, not the prior turn end', () => {
    const items: UiItem[] = [
      {
        kind: 'message',
        id: 'u1',
        role: 'user',
        content: 'first',
        at: '2026-07-24T12:00:00.000Z'
      },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'done',
        at: '2026-07-24T12:00:05.000Z'
      },
      {
        kind: 'message',
        id: 'u2',
        role: 'user',
        content: 'second',
        at: '2026-07-24T17:00:06.000Z'
      },
      tool('t1'),
      {
        kind: 'message',
        id: 'a2',
        role: 'assistant',
        content: 'ok',
        at: '2026-07-24T17:05:55.000Z'
      }
    ]
    const readTool = items[3]
    if (readTool?.kind === 'tool') {
      readTool.at = '2026-07-24T17:00:10.000Z'
      readTool.groupTiming = {
        startedAt: new Date('2026-07-24T17:00:10.000Z').getTime(),
        endedAt: new Date('2026-07-24T17:01:00.000Z').getTime()
      }
    }
    const summaries = buildTranscriptRows(items).filter((row) => row.kind === 'turn')
    // Text-only first turn has no work row, so only the follow-up is summarized.
    expect(summaries).toHaveLength(1)
    const followUp = summaries[0]
    expect(followUp?.kind).toBe('turn')
    if (followUp?.kind === 'turn') {
      expect(followUp.span.endedAt! - followUp.span.startedAt!).toBe(5 * 60_000 + 49_000)
    }
  })

  it('marks a turn active while a tool is still running', () => {
    const running = tool('t1')
    running.tool.status = 'running'
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      running
    ]
    const summary = buildTranscriptRows(items, { running: true }).find(
      (row) => row.kind === 'turn'
    )
    if (summary?.kind === 'turn') expect(summary.span.active).toBe(true)
  })

  it('renders an orphaned running tool turn as finished when no run is live', () => {
    // A run that died (crash/reload/interruption) leaves rows at status
    // 'running' — the turn must not shimmer and tick forever.
    const orphaned = tool('t1')
    orphaned.tool.status = 'running'
    orphaned.at = '2026-07-25T10:00:05.000Z'
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go', at: '2026-07-25T10:00:00.000Z' },
      orphaned
    ]
    const summary = buildTranscriptRows(items).find((row) => row.kind === 'turn')
    expect(summary?.kind).toBe('turn')
    if (summary?.kind === 'turn') {
      expect(summary.span.active).toBe(false)
      expect(summary.span.activity).toBeNull()
      expect(summary.span.endedAt! - summary.span.startedAt!).toBe(5_000)
    }
  })

  it('does not repeat the run_error message in the turn summary label', () => {
    // The run_error row already renders the full message — the summary line
    // falling back to "Failed" must not print the same string twice.
    const message = 'Command Code rejected this request (HTTP 403): the Go plan has no API access.'
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'run_error', id: 'run-error:live:1', message, code: 'PROVIDER_HTTP' }
    ]
    const rows = buildTranscriptRows(items, {
      turnFailed: true,
      turnFailureLabel: message,
      turnStatus: 'error'
    })
    const summary = rows.find((row) => row.kind === 'turn')
    expect(summary?.kind).toBe('turn')
    if (summary?.kind !== 'turn') return
    expect(summary.span.failed).toBe(true)
    expect(summary.span.failureLabel).toBeUndefined()
    expect(
      rows.some((row) => row.kind === 'run_error' && row.message === message)
    ).toBe(true)
  })

  it('keeps the turn failure label when the turn has no run_error row', () => {
    // A network drop leaves the error only in state — the summary label is the
    // sole place the message is visible, so it must survive.
    const items: UiItem[] = [{ kind: 'message', id: 'u1', role: 'user', content: 'hi' }]
    const rows = buildTranscriptRows(items, {
      turnFailed: true,
      turnFailureLabel: 'Connection lost'
    })
    const summary = rows.find((row) => row.kind === 'turn')
    expect(summary?.kind).toBe('turn')
    if (summary?.kind !== 'turn') return
    expect(summary.span.failed).toBe(true)
    expect(summary.span.failureLabel).toBe('Connection lost')
  })

  it('omits the turn summary when a turn did no work', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'hello' }
    ]
    expect(buildTranscriptRows(items).some((row) => row.kind === 'turn')).toBe(false)
  })

  it('still marks the closing answer final when a compaction card follows it', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'Here is the answer.' },
      {
        kind: 'compaction',
        id: 'c1',
        summary: 'Folded prior turns.',
        verifyStatus: 'verified'
      }
    ]
    const rows = buildTranscriptRows(items)
    const answer = rows.find((row) => row.kind === 'text' && row.id === 'a1')
    expect(answer?.kind === 'text' ? answer.final : undefined).toBe(true)
  })

  it('only the closing answer of a turn is marked final', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'first' },
      { kind: 'message', id: 'a2', role: 'assistant', content: 'second' }
    ]
    const finals = buildTranscriptRows(items)
      .filter((row) => row.kind === 'text')
      .map((row) => (row.kind === 'text' ? row.final : null))
    expect(finals).toEqual([false, true])
  })

  it('does not treat mid-turn narration as final when work continues after it', () => {
    const todo = tool('todo1', 'todo_write')
    todo.tool.summary = '0/5 complete'
    const running = tool('sub1', 'search')
    running.tool.status = 'running'
    running.tool.summary = 'Audit the codebase'
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        thinking: 'Planning the full repository audit now.',
        content: ''
      },
      { kind: 'message', id: 'a2', role: 'assistant', content: 'Hi again! Starting the audit.' },
      todo,
      {
        kind: 'message',
        id: 'a3',
        role: 'assistant',
        thinking: 'Launching searches.',
        thinkingStreaming: true,
        content: ''
      },
      running
    ]
    const rows = buildTranscriptRows(items)
    const kinds = rows.map((row) => row.kind)
    const narration = rows.find((row) => row.kind === 'text' && row.id === 'a2')
    const summaryIndex = rows.findIndex((row) => row.kind === 'turn')
    const activityIndex = rows.findIndex((row) => row.kind === 'activity')

    expect(narration?.kind === 'text' ? narration.final : undefined).toBe(false)
    expect(summaryIndex).toBeGreaterThan(activityIndex)
    expect(kinds.indexOf('turn')).toBeGreaterThan(kinds.lastIndexOf('activity'))
  })

  it('places the turn summary after work and before the closing answer', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      tool('r1', 'read'),
      { kind: 'message', id: 'a1', role: 'assistant', content: 'Here is the answer.' }
    ]
    const kinds = buildTranscriptRows(items).map((row) => row.kind)
    expect(kinds).toEqual(['user', 'activity', 'turn', 'text'])
  })

  it('rolls up a turn that edited several files', async () => {
    const first = tool('e1', 'edit')
    first.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\ny\n' })
    const second = tool('e2', 'edit')
    second.tool.argsPreview = JSON.stringify({ path: 'src/b.ts', contents: 'z\n' })

    const changes = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'edit both' },
      first,
      second
    ]).find((row) => row.kind === 'changes')

    expect(changes?.kind).toBe('changes')
    if (changes?.kind === 'changes') {
      expect(changes.files).toEqual([
        { path: 'src/a.ts', added: 2, removed: 0 },
        { path: 'src/b.ts', added: 1, removed: 0 }
      ])
    }
  })

  it('merges same file when change paths use mixed separators', () => {
    const first = tool('e1', 'edit')
    first.tool.argsPreview = JSON.stringify({ path: 'src\\a.ts', contents: 'x\ny\n' })
    const second = tool('e2', 'edit')
    second.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\ny\nz\n' })

    const changes = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'edit' },
      first,
      second
    ]).find((row) => row.kind === 'changes')

    expect(changes?.kind).toBe('changes')
    if (changes?.kind === 'changes') {
      expect(changes.files).toHaveLength(1)
      expect(changes.files[0]?.path).toBe('src/a.ts')
    }
  })

  it('adds a Files Changed summary for a single edit (transcript receipt)', () => {
    const only = tool('e1', 'edit')
    only.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\n' })
    const rows = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'edit it' },
      only
    ])
    const changes = rows.find((row) => row.kind === 'changes')
    expect(changes?.kind).toBe('changes')
    if (changes?.kind === 'changes') {
      expect(changes.files).toEqual([{ path: 'src/a.ts', added: 1, removed: 0 }])
    }
  })

  it('sorts Files Changed paths alphabetically to match the Changes panel', () => {
    const zebra = tool('e1', 'edit')
    zebra.tool.argsPreview = JSON.stringify({ path: 'zebra.ts', contents: 'z\n' })
    const alpha = tool('e2', 'edit')
    alpha.tool.argsPreview = JSON.stringify({ path: 'alpha.ts', contents: 'a\n' })
    const mid = tool('e3', 'edit')
    mid.tool.argsPreview = JSON.stringify({ path: 'mid.ts', contents: 'm\n' })
    const rows = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'edit' },
      zebra,
      alpha,
      mid
    ])
    const changes = rows.find((row) => row.kind === 'changes')
    expect(changes?.kind).toBe('changes')
    if (changes?.kind === 'changes') {
      expect(changes.files.map((f) => f.path)).toEqual(['alpha.ts', 'mid.ts', 'zebra.ts'])
    }
  })

  it('defers the Files Changed card on the live turn until the run settles', () => {
    const edit = tool('e1', 'edit')
    edit.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\n' })
    const sub: UiItem = {
      kind: 'tool',
      id: 's1',
      tool: { id: 's1', name: 'search', summary: 'Investigate', status: 'running' }
    }

    const live = buildTranscriptRows(
      [
        { kind: 'message', id: 'u1', role: 'user', content: 'edit then investigate' },
        edit,
        sub
      ],
      { running: true }
    )
    expect(live.some((row) => row.kind === 'changes')).toBe(false)
    expect(live.some((row) => row.kind === 'activity')).toBe(true)

    const settled = buildTranscriptRows(
      [
        { kind: 'message', id: 'u1', role: 'user', content: 'edit then investigate' },
        edit,
        {
          kind: 'tool',
          id: 's1',
          tool: { id: 's1', name: 'search', summary: 'Investigate', status: 'done' }
        }
      ],
      { running: false }
    )
    const changes = settled.find((row) => row.kind === 'changes')
    expect(changes?.kind).toBe('changes')
    if (changes?.kind === 'changes') {
      expect(changes.files).toEqual([{ path: 'src/a.ts', added: 1, removed: 0 }])
    }
  })

  it('still shows Files Changed for a prior turn while a later turn is live', () => {
    const firstEdit = tool('e1', 'edit')
    firstEdit.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\n' })
    const secondEdit = tool('e2', 'edit')
    secondEdit.tool.argsPreview = JSON.stringify({ path: 'src/b.ts', contents: 'y\n' })

    const rows = buildTranscriptRows(
      [
        { kind: 'message', id: 'u1', role: 'user', content: 'first' },
        firstEdit,
        { kind: 'message', id: 'u2', role: 'user', content: 'second' },
        secondEdit,
        {
          kind: 'tool',
          id: 'r1',
          tool: { id: 'r1', name: 'read', summary: 'x', status: 'running' }
        }
      ],
      { running: true }
    )
    const changes = rows.filter((row) => row.kind === 'changes')
    expect(changes).toHaveLength(1)
    if (changes[0]?.kind === 'changes') {
      expect(changes[0].turnIndex).toBe(0)
      expect(changes[0].files).toEqual([{ path: 'src/a.ts', added: 1, removed: 0 }])
    }
  })

  it('adds up repeated edits to the same file', () => {
    const first = tool('e1', 'edit')
    first.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\ny\n' })
    const second = tool('e2', 'edit')
    second.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' })
    const other = tool('e3', 'edit')
    other.tool.argsPreview = JSON.stringify({ path: 'src/b.ts', contents: 'z\n' })

    const changes = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      first,
      second,
      other
    ]).find((row) => row.kind === 'changes')

    if (changes?.kind === 'changes') {
      expect(changes.files[0]).toEqual({ path: 'src/a.ts', added: 3, removed: 1 })
    }
  })

  it('reserves extra lead-in for user prompts that open a later turn', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'first' },
      { kind: 'message', id: 'u2', role: 'user', content: 'second' }
    ]
    const [first, second] = buildTranscriptRows(items)
    expect(rowLeadingGap(first!)).toBe(0)
    expect(rowLeadingGap(second!)).toBe(TURN_GAP_PX)
  })

  it('emits an approval row instead of a card while an edit is gated', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 'w1',
        tool: { id: 'w1', name: 'edit', summary: 'a.ts', status: 'running' },
        approval: {
          requestId: 'req-1',
          toolName: 'edit',
          summary: 'a.ts',
          argsPreview: '{}',
          mutating: true
        }
      }
    ])
    expect(rows.map((row) => row.kind)).toEqual(['approval'])
    expect(rows.some((row) => row.kind === 'card')).toBe(false)
  })

  it('emits a question row and hides the gated ask_question tool card', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 'q1',
        tool: { id: 'q1', name: 'ask_question', summary: 'Pick?', status: 'running' }
      },
      {
        kind: 'question',
        id: 'question:req-q',
        question: {
          requestId: 'req-q',
          toolCallId: 'q1',
          questions: [
            { id: 'q1', prompt: 'Pick?', type: 'single', options: ['A', 'B'] }
          ]
        }
      }
    ])
    expect(rows.map((row) => row.kind)).toEqual(['question'])
    expect(rows.some((row) => row.kind === 'card')).toBe(false)
  })

  it('strips leaked tool JSON from assistant text rows', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'tool {"edits":[{"path":"api.ts","contents":"x"}]}\nVerified the routes.'
      }
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('text')
    if (rows[0]?.kind === 'text') {
      expect(rows[0].item.content).toBe('Verified the routes.')
    }
  })

  it('hides in-progress tool JSON while assistant text is still streaming', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Checking routes.\ntool {"path":"api.ts"',
        streaming: true
      }
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('text')
    if (rows[0]?.kind === 'text') {
      expect(rows[0].item.content).toBe('Checking routes.')
    }
  })

  it('gives terminal tools a card when presentation is prominent', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'terminal',
          summary: 'pnpm test',
          status: 'running',
          argsPreview: '{"command":"pnpm test"}',
          presentation: 'prominent'
        }
      }
    ])
    expect(rows[0]?.kind).toBe('card')
  })

  it('keeps read-only terminal commands in activity groups', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'terminal',
          summary: 'cat README.md',
          status: 'done',
          argsPreview: '{"command":"cat README.md"}'
        }
      }
    ])
    expect(rows[0]?.kind).toBe('activity')
  })

  it('demotes read-only terminal via summary when argsPreview is missing', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'terminal',
          summary: 'cat README.md',
          status: 'done'
        }
      }
    ])
    expect(rows[0]?.kind).toBe('activity')
  })

  it('treats card rows as turn work (collapsed turns hide them)', () => {
    expect(
      isTurnWorkRow({
        kind: 'card',
        id: 't-run',
        turnIndex: 0,
        item: {
          kind: 'tool',
          id: 't-run',
          tool: { id: 't-run', name: 'terminal', summary: 'npm test', status: 'running' }
        }
      })
    ).toBe(true)
  })

  it('keeps activity batches split by thinking in step order', () => {
    const items: UiItem[] = [
      tool('r1', 'read'),
      tool('r2', 'read'),
      {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        thinking: 'Mapping the repository tree before edits.',
        content: ''
      },
      tool('r3', 'read'),
      tool('r4', 'read')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((row) => row.kind)).toEqual(['activity', 'thinking', 'activity'])
    const activities = rows.filter((row) => row.kind === 'activity')
    expect(activities).toHaveLength(2)
    if (activities[0]?.kind === 'activity' && activities[1]?.kind === 'activity') {
      expect(activities[0].tools).toHaveLength(2)
      expect(activities[1].tools).toHaveLength(2)
    }
  })

  it('keeps activity batches split by finished thinking separators', () => {
    const items: UiItem[] = [
      tool('r1', 'read'),
      tool('g1', 'grep'),
      {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        thinking: 'Mapping the repository tree before the next lookups.',
        content: ''
      },
      tool('r2', 'read'),
      tool('g2', 'grep')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((row) => row.kind)).toEqual(['activity', 'thinking', 'activity'])
    const activities = rows.filter((row) => row.kind === 'activity')
    expect(activities).toHaveLength(2)
    if (activities[0]?.kind === 'activity' && activities[1]?.kind === 'activity') {
      expect(activities[0].tools.map((item) => item.id)).toEqual(['r1', 'g1'])
      expect(activities[1].tools.map((item) => item.id)).toEqual(['r2', 'g2'])
    }
  })

  it('does not reorder live streaming thinking across activity merge', () => {
    const items: UiItem[] = [
      tool('r1', 'read'),
      tool('g1', 'grep'),
      {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        thinking: 'ok',
        thinkingStreaming: true,
        content: ''
      },
      tool('r2', 'read'),
      tool('g2', 'grep')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((row) => row.kind)).toEqual([
      'activity',
      'thinking',
      'activity'
    ])
    const thinking = rows[1]
    expect(thinking?.kind).toBe('thinking')
    if (thinking?.kind === 'thinking') {
      expect(thinking.item.thinkingStreaming).toBe(true)
    }
    const activities = rows.filter((row) => row.kind === 'activity')
    expect(activities).toHaveLength(2)
    if (activities[0]?.kind === 'activity' && activities[1]?.kind === 'activity') {
      expect(activities[0].tools.map((item) => item.id)).toEqual(['r1', 'g1'])
      expect(activities[1].tools.map((item) => item.id)).toEqual(['r2', 'g2'])
    }
  })

  it('keeps lookup batches chronological around a sandwiched terminal card', () => {
    const items: UiItem[] = [
      tool('r1', 'read'),
      tool('d1', 'list_dir'),
      tool('t1', 'terminal'),
      tool('r2', 'read'),
      tool('d2', 'list_dir')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((row) => row.kind)).toEqual(['activity', 'card', 'activity'])
    const first = rows[0]
    if (first?.kind === 'activity') {
      expect(first.tools.map((item) => item.id)).toEqual(['r1', 'd1'])
    }
    expect(rows[1]?.kind).toBe('card')
    expect(rows[1]?.id).toBe('t1')
    const second = rows[2]
    if (second?.kind === 'activity') {
      expect(second.tools.map((item) => item.id)).toEqual(['r2', 'd2'])
    }
  })

  it('places Files Changed after the closing answer, with turn summary after work', () => {
    const edit = tool('e1', 'edit')
    edit.tool.argsPreview = JSON.stringify({ path: 'src/a.ts', contents: 'x\n' })
    const kinds = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'edit' },
      edit,
      { kind: 'message', id: 'a1', role: 'assistant', content: 'Done.' }
    ]).map((row) => row.kind)
    expect(kinds).toEqual(['user', 'card', 'turn', 'text', 'changes'])
  })

  it('keeps step reasoning inline between tool batches', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'audit' },
      {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        thinking: 'First I will read the core files.',
        content: ''
      },
      tool('r1', 'read'),
      {
        kind: 'message',
        id: 'm2',
        role: 'assistant',
        thinking: 'Next I will grep for auth usage.',
        content: ''
      },
      tool('g1', 'grep'),
      {
        kind: 'message',
        id: 'm3',
        role: 'assistant',
        thinking: 'Finally I will run the tests.',
        content: ''
      },
      tool('t1', 'terminal')
    ]
    const rows = buildTranscriptRows(items)
    expect(rows.map((row) => row.kind)).toEqual([
      'user',
      'thinking',
      'activity',
      'thinking',
      'activity',
      'thinking',
      'card',
      'turn'
    ])
  })

  it('attaches tool activity to an active turn with a running tool', () => {
    const running = tool('t1', 'read')
    running.tool.status = 'running'
    running.tool.summary = 'package.json'
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      running
    ]
    const summary = buildTranscriptRows(items, { running: true }).find(
      (row) => row.kind === 'turn'
    )
    expect(summary?.kind).toBe('turn')
    if (summary?.kind === 'turn') {
      expect(summary.span.activity).toEqual({
        kind: 'tool',
        label: 'Reading',
        detail: 'package.json'
      })
    }
  })

  it('attaches thinking activity while reasoning streams and no tools are running', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: '',
        thinking: 'Let me reason about this carefully.',
        thinkingStreaming: true
      }
    ]
    const summary = buildTranscriptRows(items, { running: true }).find(
      (row) => row.kind === 'turn'
    )
    if (summary?.kind === 'turn') {
      expect(summary.span.activity).toEqual({ kind: 'thinking' })
    }
  })

  it('shows a working turn summary while pendingRun is true with no rows yet', () => {
    const items: UiItem[] = [{ kind: 'message', id: 'u1', role: 'user', content: 'go' }]
    const rows = buildTranscriptRows(items, { pendingRun: true })
    const summary = rows.find((row) => row.kind === 'turn')
    expect(summary?.kind).toBe('turn')
    if (summary?.kind === 'turn') {
      expect(summary.span.active).toBe(true)
      expect(summary.span.activity).toEqual({ kind: 'working' })
    }
  })

  it('keeps the turn summary live while running before the first stream event', () => {
    const items: UiItem[] = [{ kind: 'message', id: 'u1', role: 'user', content: 'go' }]
    const rows = buildTranscriptRows(items, { running: true })
    const summary = rows.find((row) => row.kind === 'turn')
    expect(summary?.kind).toBe('turn')
    if (summary?.kind === 'turn') {
      expect(summary.span.active).toBe(true)
      expect(summary.span.activity).toEqual({ kind: 'working' })
    }
  })

  it('shows Planning while a coalesced todo_write is running', () => {
    const running = tool('todo1', 'todo_write')
    running.tool.status = 'running'
    running.tool.summary = '1 task'
    const rows = buildTranscriptRows(
      [
        { kind: 'message', id: 'u1', role: 'user', content: 'ship the planning gate' },
        running
      ],
      { pendingRun: true }
    )
    const todoTools = rows.flatMap((row) =>
      row.kind === 'activity' ? row.tools.filter((item) => item.tool.name === 'todo_write') : []
    )
    expect(todoTools).toHaveLength(0)
    const summary = rows.find((row) => row.kind === 'turn')
    expect(summary?.kind).toBe('turn')
    if (summary?.kind === 'turn') {
      expect(summary.span.active).toBe(true)
      expect(summary.span.activity).toEqual({ kind: 'planning' })
    }
  })

  it('omits successful todo_write from the transcript (Tasks band owns the checklist)', () => {
    const first = tool('todo1', 'todo_write')
    first.tool.summary = '5 tasks'
    const second = tool('todo2', 'todo_write')
    second.tool.summary = '0/5 complete'
    second.tool.content = '0/5 complete\n[ ] Audit core library code'
    const rows = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'plan' },
      first,
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        thinking: 'Updating the checklist with the latest progress.',
        content: ''
      },
      second
    ])
    const todoTools = rows.flatMap((row) =>
      row.kind === 'activity'
        ? row.tools.filter((item) => item.tool.name === 'todo_write')
        : []
    )
    expect(todoTools).toHaveLength(0)
  })

  it('keeps failed todo_write inline so errors stay visible', () => {
    const failed = tool('todo-fail', 'todo_write')
    failed.tool.status = 'fail'
    failed.tool.summary = 'todos: Required'
    failed.tool.content = 'todos: Required'
    const rows = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'plan' },
      failed
    ])
    const todoTools = rows.flatMap((row) =>
      row.kind === 'activity'
        ? row.tools.filter((item) => item.tool.name === 'todo_write')
        : []
    )
    expect(todoTools).toHaveLength(1)
    expect(todoTools[0]?.id).toBe('todo-fail')
  })

  it('omits short finished thinking so padded empty gaps are not created', () => {
    const rows = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        thinking: 'OK',
        content: 'Done.'
      }
    ])
    expect(rows.map((row) => row.kind)).toEqual(['user', 'text'])
  })

  it('shows Thinking on the timeline when showThinking is false but reasoning is streaming', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        thinking: 'Let me reason about this carefully.',
        thinkingStreaming: true,
        content: ''
      }
    ]
    const rows = buildTranscriptRows(items, { showThinking: false, running: true })
    expect(rows.some((row) => row.kind === 'thinking')).toBe(false)
    const summary = rows.find((row) => row.kind === 'turn')
    if (summary?.kind === 'turn') {
      expect(summary.span.activity?.kind).toBe('thinking')
    }
  })

  it('keeps approval rows visible when a turn is collapsed', () => {
    expect(
      isTurnWorkRow({
        kind: 'approval',
        id: 'a1',
        turnIndex: 0,
        approval: {
          requestId: 'r1',
          toolName: 'edit',
          summary: 'edit',
          mutating: true
        }
      })
    ).toBe(false)
  })

  it('detects visible tool work rows for a turn', () => {
    expect(
      turnHasVisibleToolWork(
        [
          {
            kind: 'activity',
            id: 'a-run',
            turnIndex: 0,
            tools: [
              {
                kind: 'tool',
                id: 't1',
                tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'running' }
              }
            ]
          }
        ],
        0
      )
    ).toBe(true)
    expect(
      turnHasVisibleToolWork(
        [
          {
            kind: 'card',
            id: 'c1',
            turnIndex: 1,
            item: {
              kind: 'tool',
              id: 'c1',
              tool: { id: 'c1', name: 'terminal', summary: 'npm test', status: 'running' }
            }
          }
        ],
        1
      )
    ).toBe(true)
    expect(
      turnHasVisibleToolWork(
        [
          {
            kind: 'approval',
            id: 'apr',
            turnIndex: 0,
            approval: {
              requestId: 'r1',
              toolName: 'edit',
              summary: 'edit',
              mutating: true
            }
          }
        ],
        0
      )
    ).toBe(false)
    expect(
      turnHasVisibleToolWork(
        [
          {
            kind: 'thinking',
            id: 'th',
            turnIndex: 0,
            item: {
              kind: 'message',
              id: 'th',
              role: 'assistant',
              content: '',
              thinking: 'plan'
            }
          }
        ],
        0
      )
    ).toBe(false)
  })

  it('keeps question rows visible when a turn is collapsed', () => {
    expect(
      isTurnWorkRow({
        kind: 'question',
        id: 'q1',
        turnIndex: 0,
        question: {
          requestId: 'rq',
          toolCallId: 't1',
          questions: [{ id: 'q1', prompt: 'Continue?', type: 'boolean' }]
        }
      })
    ).toBe(false)
  })

  it('hides running tool activity when a turn is collapsed (timeline owns live phase)', () => {
    expect(
      isTurnWorkRow({
        kind: 'activity',
        id: 'a-run',
        turnIndex: 0,
        tools: [
          {
            kind: 'tool',
            id: 't-run',
            tool: { id: 't-run', name: 'terminal', summary: 'npm test', status: 'running' }
          }
        ]
      })
    ).toBe(true)
    expect(
      isTurnWorkRow({
        kind: 'activity',
        id: 'a-done',
        turnIndex: 0,
        tools: [
          {
            kind: 'tool',
            id: 't-done',
            tool: { id: 't-done', name: 'terminal', summary: 'npm test', status: 'done' }
          }
        ]
      })
    ).toBe(true)
  })
})

describe('transcriptRowFingerprint / stabilizeTranscriptRows', () => {
  it('invalidates activity identity when tool content grows', () => {
    const base: UiItem = {
      kind: 'tool',
      id: 't1',
      tool: {
        id: 't1',
        name: 'read',
        summary: 'a.ts',
        status: 'done',
        content: 'short'
      }
    }
    const grown: UiItem = {
      ...base,
      tool: { ...base.tool, content: 'short'.repeat(40) }
    }
    const prev = buildTranscriptRows([base])
    const next = buildTranscriptRows([grown])
    expect(prev[0]?.kind).toBe('activity')
    expect(next[0]?.kind).toBe('activity')
    if (prev[0]?.kind !== 'activity' || next[0]?.kind !== 'activity') return
    expect(transcriptRowFingerprint(prev[0])).not.toBe(transcriptRowFingerprint(next[0]))
    const stable = stabilizeTranscriptRows(prev, next)
    expect(stable[0]).toBe(next[0])
    expect(stable[0]).not.toBe(prev[0])
  })

  it('reuses activity row identity when only unrelated fields are unchanged', () => {
    const item: UiItem = {
      kind: 'tool',
      id: 't1',
      tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'done', content: 'body' }
    }
    const prev = buildTranscriptRows([item])
    const next = buildTranscriptRows([{ ...item }])
    const stable = stabilizeTranscriptRows(prev, next)
    expect(stable[0]).toBe(prev[0])
  })

  it('invalidates question identity when prompt/options change for the same requestId', () => {
    const prev = buildTranscriptRows([
      {
        kind: 'question',
        id: 'q-ui',
        question: {
          requestId: 'req-1',
          toolCallId: 't1',
          questions: [{ id: 'a', prompt: 'Pick one', type: 'single', options: ['A', 'B'] }]
        }
      }
    ])
    const next = buildTranscriptRows([
      {
        kind: 'question',
        id: 'q-ui',
        question: {
          requestId: 'req-1',
          toolCallId: 't1',
          questions: [
            { id: 'a', prompt: 'Pick one now', type: 'single', options: ['A', 'B', 'C'] }
          ]
        }
      }
    ])
    expect(prev[0]?.kind).toBe('question')
    expect(next[0]?.kind).toBe('question')
    if (prev[0]?.kind !== 'question' || next[0]?.kind !== 'question') return
    expect(transcriptRowFingerprint(prev[0])).not.toBe(transcriptRowFingerprint(next[0]))
    const stable = stabilizeTranscriptRows(prev, next)
    expect(stable[0]).toBe(next[0])
    expect(stable[0]).not.toBe(prev[0])
  })

  it('invalidates text identity when content changes at the same length', () => {
    const prev = buildTranscriptRows([
      {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        content: 'hello world!!!'
      }
    ])
    const next = buildTranscriptRows([
      {
        kind: 'message',
        id: 'm1',
        role: 'assistant',
        content: 'HELLO WORLD!!!'
      }
    ])
    const prevText = prev.find((row) => row.kind === 'text')
    const nextText = next.find((row) => row.kind === 'text')
    expect(prevText?.kind).toBe('text')
    expect(nextText?.kind).toBe('text')
    if (prevText?.kind !== 'text' || nextText?.kind !== 'text') return
    expect(prevText.item.content.length).toBe(nextText.item.content.length)
    expect(transcriptRowFingerprint(prevText)).not.toBe(transcriptRowFingerprint(nextText))
    const stable = stabilizeTranscriptRows(
      prev.filter((row) => row.kind === 'text'),
      next.filter((row) => row.kind === 'text')
    )
    expect(stable[0]).toBe(nextText)
  })

  it('invalidates text identity when only the middle changes at the same length', () => {
    const left = 'AAAAAAAAAAAAAAA_' // 16
    const right = '_BBBBBBBBBBBBBBB' // 16
    const midA = 'xxxxxxxxxxxxMIDDLExxxxxxxx' // 26
    const midB = 'yyyyyyyyyyyyMIDDLEyyyyyyyy' // 26
    const a = `${left}${midA}${right}`
    const b = `${left}${midB}${right}`
    expect(a.length).toBe(b.length)
    expect(a.length).toBeGreaterThan(48)
    const prev = buildTranscriptRows([{ kind: 'message', id: 'm1', role: 'assistant', content: a }])
    const next = buildTranscriptRows([{ kind: 'message', id: 'm1', role: 'assistant', content: b }])
    const prevText = prev.find((row) => row.kind === 'text')
    const nextText = next.find((row) => row.kind === 'text')
    if (prevText?.kind !== 'text' || nextText?.kind !== 'text') return
    expect(transcriptRowFingerprint(prevText)).not.toBe(transcriptRowFingerprint(nextText))
    const stable = stabilizeTranscriptRows([prevText], [nextText])
    expect(stable[0]).toBe(nextText)
  })

  it('treats thinkingStreaming as live and does not reuse a stale thinking row', () => {
    const prev = buildTranscriptRows([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: '',
        thinking: 'plan A',
        thinkingStreaming: true
      }
    ])
    const next = buildTranscriptRows([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: '',
        thinking: 'plan B',
        thinkingStreaming: true
      }
    ])
    const prevThinking = prev.find((row) => row.kind === 'thinking')
    const nextThinking = next.find((row) => row.kind === 'thinking')
    expect(prevThinking?.kind).toBe('thinking')
    expect(nextThinking?.kind).toBe('thinking')
    if (prevThinking?.kind !== 'thinking' || nextThinking?.kind !== 'thinking') return
    // Force a fingerprint collision so only the live-flag path rejects reuse.
    const collidingPrev = {
      ...prevThinking,
      item: { ...prevThinking.item, thinking: nextThinking.item.thinking }
    }
    expect(transcriptRowFingerprint(collidingPrev)).toBe(transcriptRowFingerprint(nextThinking))
    const stable = stabilizeTranscriptRows([collidingPrev], [nextThinking])
    expect(stable[0]).toBe(nextThinking)
    expect(stable[0]).not.toBe(collidingPrev)
  })

  it('emits a compaction row for summarized context', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'compaction',
        id: 'c1',
        summary: 'Folded the setup turns into a short brief.',
        tokenEstimate: 800
      }
    ]
    const rows = buildTranscriptRows(items)
    const compact = rows.find((row) => row.kind === 'compaction')
    expect(compact?.kind).toBe('compaction')
    if (compact?.kind !== 'compaction') return
    expect(compact.summary).toBe('Folded the setup turns into a short brief.')
    expect(compact.tokenEstimate).toBe(800)
    expect(compact.turnIndex).toBe(0)
    expect(isTurnWorkRow(compact)).toBe(false)
  })

  it('marks the live turn as Compacting when compacting option is set', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'hello' }
    ]
    const rows = buildTranscriptRows(items, { running: true, compacting: true })
    const turn = rows.find((row) => row.kind === 'turn')
    expect(turn?.kind).toBe('turn')
    if (turn?.kind !== 'turn') return
    expect(turn.span.active).toBe(true)
    expect(turn.span.activity).toEqual({ kind: 'compacting' })
  })

  it('uses the live compact card verify status for the timeline phase', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'hello' },
      {
        kind: 'compaction',
        id: 'compaction:in-flight',
        summary: 'draft',
        verifyStatus: 'verifying'
      }
    ]
    const rows = buildTranscriptRows(items, { running: true, compacting: true })
    const turn = rows.find((row) => row.kind === 'turn')
    expect(turn?.kind).toBe('turn')
    if (turn?.kind !== 'turn') return
    expect(turn.span.activity).toEqual({ kind: 'verifying_compact' })
  })

  it('invalidates compaction identity when verifyStatus changes', () => {
    const base: UiItem = {
      kind: 'compaction',
      id: 'compaction:in-flight',
      summary: 'Folded prior turns.',
      verifyStatus: 'verifying'
    }
    const retrying: UiItem = { ...base, verifyStatus: 'retrying' }
    const prev = buildTranscriptRows([base])
    const next = buildTranscriptRows([retrying])
    const prevRow = prev.find((row) => row.kind === 'compaction')
    const nextRow = next.find((row) => row.kind === 'compaction')
    expect(prevRow?.kind).toBe('compaction')
    expect(nextRow?.kind).toBe('compaction')
    if (prevRow?.kind !== 'compaction' || nextRow?.kind !== 'compaction') return
    expect(transcriptRowFingerprint(prevRow)).not.toBe(transcriptRowFingerprint(nextRow))
    const stable = stabilizeTranscriptRows(prev, next)
    const stableRow = stable.find((row) => row.kind === 'compaction')
    expect(stableRow).toBe(nextRow)
    expect(stableRow).not.toBe(prevRow)
  })

  it('does not reuse a verifying compaction row even on fingerprint collision', () => {
    const verifying: TranscriptRow = {
      kind: 'compaction',
      id: 'compaction:in-flight',
      summary: 'Folded prior turns.',
      turnIndex: 0,
      verifyStatus: 'verifying'
    }
    const retrying: TranscriptRow = {
      ...verifying,
      verifyStatus: 'retrying'
    }
    const collidingPrev: TranscriptRow = {
      ...verifying,
      verifyStatus: 'retrying'
    }
    expect(transcriptRowFingerprint(collidingPrev)).toBe(transcriptRowFingerprint(retrying))
    const stable = stabilizeTranscriptRows([collidingPrev], [retrying])
    expect(stable[0]).toBe(retrying)
    expect(stable[0]).not.toBe(collidingPrev)
  })
})
