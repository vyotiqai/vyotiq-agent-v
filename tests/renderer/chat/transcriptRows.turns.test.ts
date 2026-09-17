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
})
