import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-userdata-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

import {
  appendMessage,
  listRuns,
  listRunsOlder,
  interruptOrphanRuns,
  loadEvents,
  loadMessages,
  createRun,
  renameRun,
  resumeRun,
  syncMessages,
  patchLatestTodoWriteMessage
} from '@main/agent/state'
import { RUN_INTERRUPTED_ERROR } from '@shared/runInterrupt'
import { finalizeTodosOnRunEnd, readTodos, toolTodoWrite } from '@main/agent/tools/todo'
import { resolveRunDir } from '@main/storage/paths'
import { registerRunAbort, clearRunAbort } from '@main/agent/runRegistry'

function writeStatus(
  dir: string,
  status: { status: string; step?: number; updatedAt: string; goal?: string; error?: string; workspacePath?: string }
): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status, null, 2), 'utf8')
}

describe('listRuns / interruptOrphanRuns', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-ws-${process.pid}-${Date.now()}-${Math.random()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(userData, 'sessions'), { recursive: true })
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('lists workspace runs only', async () => {
    writeStatus(resolveRunDir(workspace, 'ws-run'), {
      status: 'done',
      updatedAt: '2026-01-03T00:00:00.000Z',
      goal: 'workspace',
      workspacePath: workspace
    })
    writeStatus(join(userData, 'sessions', 'session-run'), {
      status: 'done',
      updatedAt: '2026-01-02T00:00:00.000Z',
      goal: 'session'
    })

    const result = await listRuns(workspace)
    expect(result.runs.map((r) => r.runId)).toEqual(['ws-run'])
    expect(result.capped).toBe(false)
  })

  it('reports capped when more than 30 runs exist', async () => {
    for (let i = 0; i < 31; i++) {
      const stamp = String(i).padStart(2, '0')
      writeStatus(resolveRunDir(workspace, `run-${stamp}`), {
        status: 'done',
        updatedAt: `2026-01-01T00:${stamp}:00.000Z`,
        goal: `run ${stamp}`,
        workspacePath: workspace
      })
    }

    const result = await listRuns(workspace)
    expect(result.runs).toHaveLength(30)
    expect(result.capped).toBe(true)
  })

  it('lists older pages beyond the cap strictly below the cursor', async () => {
    for (let i = 0; i < 33; i++) {
      const stamp = String(i).padStart(2, '0')
      writeStatus(resolveRunDir(workspace, `run-${stamp}`), {
        status: 'done',
        updatedAt: `2026-01-01T00:${stamp}:00.000Z`,
        goal: `run ${stamp}`,
        workspacePath: workspace
      })
    }

    const first = await listRuns(workspace)
    expect(first.runs).toHaveLength(30)
    // Cursor = oldest run already listed → the page holds the remaining runs.
    const cursor = first.runs.at(-1)!.updatedAt
    const page = await listRunsOlder(workspace, cursor)
    // Pages keep the same newest-first order as the main list.
    expect(page.runs.map((r) => r.runId)).toEqual(['run-02', 'run-01', 'run-00'])
    expect(page.hasMore).toBe(false)

    // A mid-list cursor returns only strictly older runs.
    const mid = await listRunsOlder(workspace, first.runs[0]!.updatedAt, 2)
    expect(mid.runs).toHaveLength(2)
    expect(mid.hasMore).toBe(true)
    for (const run of mid.runs) {
      expect(run.updatedAt < first.runs[0]!.updatedAt).toBe(true)
    }
  })

  it('loads messages and skips invalid jsonl lines', () => {
    const dir = resolveRunDir(workspace, 'msg-run')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'messages.jsonl'),
      [
        JSON.stringify({ role: 'user', content: 'hello' }),
        '{not json',
        JSON.stringify({ role: 'bogus' }),
        JSON.stringify({ role: 'assistant', content: 'hi' })
      ].join('\n'),
      'utf8'
    )

    const messages = loadMessages(workspace, 'msg-run')
    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' }
    ])
  })

  it('reads persisted events and injects legacy runId', () => {
    const dir = resolveRunDir(workspace, 'event-run')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'events.jsonl'),
      [
        JSON.stringify({ at: '2026-01-01T00:00:00.000Z', event: { type: 'status', status: 'running' } }),
        JSON.stringify({
          at: '2026-01-01T00:00:01.000Z',
          event: { type: 'tool_start', name: 'read', runId: 'event-run' }
        })
      ].join('\n'),
      'utf8'
    )

    const events = loadEvents(dir, 'event-run')
    expect(events).toHaveLength(2)
    expect(events[0]?.event).toMatchObject({
      type: 'status',
      status: 'running',
      runId: 'event-run'
    })
    expect(events[1]?.event).toMatchObject({ type: 'tool_start', name: 'read', runId: 'event-run' })
  })

  it('tail read with no complete line returns no events instead of parsing a partial line', () => {
    // Regression: while a run actively appends, a tail window can contain only
    // an in-flight partial line (no '\n'). The old fallback parsed that partial
    // text and logged "Skipping invalid events.jsonl line (json) line 1" on
    // every load (33x observed 2026-08-27). Window must yield zero events.
    const dir = resolveRunDir(workspace, 'tail-partial-run')
    mkdirSync(dir, { recursive: true })
    // One huge single line > the 64KB byte budget — no newline inside the tail window.
    const bigEvent = JSON.stringify({
      at: '2026-01-01T00:00:00.000Z',
      event: { type: 'context_usage', runId: 'tail-partial-run', pad: 'x'.repeat(120_000) }
    })
    writeFileSync(join(dir, 'events.jsonl'), bigEvent, 'utf8')

    // 64KB budget via limit (eventsTailByteBudget floor) into a 120KB+ file:
    // start > 0, and the window is entirely inside the single line (no '\n').
    const events = loadEvents(dir, 'tail-partial-run', { limit: 10 })
    expect(events).toHaveLength(0)

    // Sanity: a window that contains complete lines still parses them.
    const small = writeFileSync2(dir, 'tail-ok-run')
    expect(small).toHaveLength(1)
  })

  /** Helper: two complete small events; tail window must return exactly the last one. */
  function writeFileSync2(dir: string, runId: string): ReturnType<typeof loadEvents> {
    const d = resolveRunDir(workspace, runId)
    mkdirSync(d, { recursive: true })
    writeFileSync(
      join(d, 'events.jsonl'),
      [
        JSON.stringify({ at: '2026-01-01T00:00:00.000Z', event: { type: 'status', status: 'running' } }),
        JSON.stringify({ at: '2026-01-01T00:00:01.000Z', event: { type: 'status', status: 'done' } })
      ].join('\n'),
      'utf8'
    )
    return loadEvents(d, runId, { limit: 1 })
  }

  it('marks orphan running status as cancelled on interrupt', async () => {
    const wsDir = resolveRunDir(workspace, 'orphan-ws')
    writeStatus(wsDir, {
      status: 'running',
      step: 1,
      invokeId: 3,
      updatedAt: '2026-01-01T00:00:00.000Z',
      goal: 'also left',
      workspacePath: workspace
    })
    writeStatus(resolveRunDir(workspace, 'finished'), {
      status: 'done',
      updatedAt: '2026-01-01T00:00:00.000Z',
      workspacePath: workspace
    })

    const count = await interruptOrphanRuns([workspace])
    expect(count).toBe(1)

    const wsStatus = JSON.parse(readFileSync(join(wsDir, 'status.json'), 'utf8')) as {
      status: string
      error?: string
      invokeId?: number
      step?: number
      resumable?: true
      interruptedAt?: string
    }
    const finished = JSON.parse(
      readFileSync(join(resolveRunDir(workspace, 'finished'), 'status.json'), 'utf8')
    ) as { status: string }

    expect(wsStatus.status).toBe('cancelled')
    expect(wsStatus.error).toBe(RUN_INTERRUPTED_ERROR)
    expect(wsStatus.invokeId).toBe(3)
    expect(wsStatus.step).toBe(1)
    expect(wsStatus.resumable).toBe(true)
    expect(wsStatus.interruptedAt).toEqual(expect.any(String))
    expect(finished.status).toBe('done')

    const wsEvents = loadEvents(wsDir, 'orphan-ws')
    expect(wsEvents).toHaveLength(1)
    expect(wsEvents[0]?.event).toMatchObject({
      type: 'status',
      status: 'cancelled',
      runId: 'orphan-ws',
      invokeId: 3
    })
  })

  it('writes tool_result stubs for unfinished tool calls on interrupt', async () => {
    const runId = 'orphan-tools'
    const dir = resolveRunDir(workspace, runId)
    writeStatus(dir, {
      status: 'running',
      step: 2,
      updatedAt: '2026-01-01T00:00:00.000Z',
      goal: 'left mid-tool',
      workspacePath: workspace
    })
    syncMessages(dir, [
      { role: 'user', content: 'audit' },
      {
        role: 'assistant',
        content: 'launching',
        toolCalls: [{ id: 'tc1', name: 'read', arguments: '{"path":"a.ts"}' }]
      }
    ])

    const count = await interruptOrphanRuns([workspace])
    expect(count).toBe(1)

    const messages = loadMessages(workspace, runId)
    expect(messages).toContainEqual({
      role: 'tool',
      toolCallId: 'tc1',
      toolName: 'read',
      content: 'Cancelled',
      ok: false
    })

    const events = loadEvents(dir, runId)
    expect(events.some((row) => row.event.type === 'tool_result')).toBe(true)
  })

  it('cancels in-progress todo tasks on interrupt', async () => {
    const runId = 'orphan-todo'
    const dir = resolveRunDir(workspace, runId)
    writeStatus(dir, {
      status: 'running',
      step: 2,
      updatedAt: '2026-01-01T00:00:00.000Z',
      goal: 'left mid-todo',
      workspacePath: workspace
    })
    syncMessages(dir, [
      { role: 'user', content: 'audit' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'todo1', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool',
        toolCallId: 'todo1',
        toolName: 'todo_write',
        content: '0/5 complete\n[~] Audit core library files\n[ ] Audit API routes'
      }
    ])
    toolTodoWrite(dir, [
      { id: '1', content: 'Audit core library files', status: 'in_progress' },
      { id: '2', content: 'Audit API routes', status: 'pending' }
    ])

    const count = await interruptOrphanRuns([workspace])
    expect(count).toBe(1)

    const messages = loadMessages(workspace, runId)
    const todoMessage = messages.find((message) => message.role === 'tool' && message.toolName === 'todo_write')
    expect(todoMessage?.content).toContain('[-] Audit core library files')
    expect(todoMessage?.content).not.toContain('[~]')
    expect(readTodos(dir).find((todo) => todo.id === '1')?.status).toBe('cancelled')
  })

  it('patches latest todo_write message to pending when finalize returns done content', async () => {
    const runId = 'todo-done-patch'
    const dir = resolveRunDir(workspace, runId)
    writeStatus(dir, {
      status: 'running',
      step: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      goal: 'ship',
      workspacePath: workspace
    })
    syncMessages(dir, [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'todo1', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool',
        toolCallId: 'todo1',
        toolName: 'todo_write',
        content: '0/1 complete\n[~] Ship'
      }
    ])
    toolTodoWrite(dir, [{ id: '1', content: 'Ship', status: 'in_progress' }])
    finalizeTodosOnRunEnd(dir, 'done')
    await patchLatestTodoWriteMessage(dir, 'done')
    const todoMessage = loadMessages(workspace, runId).find(
      (message) => message.role === 'tool' && message.toolName === 'todo_write'
    )
    expect(todoMessage?.content).toContain('[ ] Ship')
    expect(todoMessage?.content).not.toContain('[~]')
    expect(readTodos(dir)[0]?.status).toBe('pending')
  })

  it('does not interrupt runs that are still active in memory', async () => {
    const liveId = 'live-run'
    const liveDir = resolveRunDir(workspace, liveId)
    writeStatus(liveDir, {
      status: 'running',
      step: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      goal: 'still going',
      workspacePath: workspace
    })
    registerRunAbort(liveId, workspace)
    try {
      const count = await interruptOrphanRuns([workspace])
      expect(count).toBe(0)
      const status = JSON.parse(readFileSync(join(liveDir, 'status.json'), 'utf8')) as {
        status: string
      }
      expect(status.status).toBe('running')
    } finally {
      clearRunAbort(liveId)
    }
  })

  it('resumeRun updates status without wiping messages or events', async () => {
    const runId = 'resume-run'
    const dir = createRun(workspace, runId, 'initial goal')
    const userMsg = { role: 'user' as const, content: 'hello' }
    const assistantMsg = { role: 'assistant' as const, content: 'hi there' }
    syncMessages(dir, [userMsg, assistantMsg])
    writeFileSync(
      join(dir, 'events.jsonl'),
      `${JSON.stringify({ at: '2026-01-01T00:00:00.000Z', event: { type: 'status', status: 'done' } })}\n`,
      'utf8'
    )
    writeFileSync(join(dir, 'contract.md'), '# Run contract\n\n## Goal\n\ninitial goal\n', 'utf8')

    const resumedDir = await resumeRun(workspace, runId)
    expect(resumedDir).toBe(dir)

    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as {
      status: string
    }
    expect(status.status).toBe('running')
    expect(loadMessages(workspace, runId)).toEqual([userMsg, assistantMsg])
    expect(readFileSync(join(dir, 'contract.md'), 'utf8')).toContain('initial goal')
    expect(loadEvents(dir, runId)).toHaveLength(1)
  })

  it('repairs orphan tool results before a queued follow-up and clears stale errors', async () => {
    const runId = 'resume-orphan'
    const dir = createRun(workspace, runId, 'repair')
    syncMessages(dir, [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'read', arguments: '{"path":"a.ts"}' }]
      }
    ])
    writeStatus(dir, {
      status: 'error',
      step: 7,
      updatedAt: '2026-01-01T00:00:00.000Z',
      error: 'old failure',
      workspacePath: workspace
    })
    appendMessage(dir, { role: 'user', content: 'continue' })

    await resumeRun(workspace, runId)

    expect(loadMessages(workspace, runId)).toEqual([
      expect.objectContaining({ role: 'assistant' }),
      {
        role: 'tool',
        toolCallId: 'tool-1',
        toolName: 'read',
        content: 'Cancelled',
        ok: false
      },
      expect.objectContaining({ role: 'user', content: 'continue' })
    ])
    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as {
      status: string
      step: number
      error?: string
    }
    expect(status).toMatchObject({ status: 'running', step: 7 })
    expect(status.error).toBeUndefined()
  })

  it('reconciles stale running runs on listRuns', async () => {
    const staleAt = new Date(Date.now() - 3 * 60_000).toISOString()
    writeStatus(resolveRunDir(workspace, 'stale-run'), {
      status: 'running',
      updatedAt: staleAt,
      goal: 'stale',
      workspacePath: workspace
    })
    writeStatus(resolveRunDir(workspace, 'fresh-run'), {
      status: 'running',
      updatedAt: new Date().toISOString(),
      goal: 'fresh',
      workspacePath: workspace
    })

    const result = await listRuns(workspace)
    expect(result.runs.find((r) => r.runId === 'stale-run')?.status).toBe('cancelled')
    expect(result.runs.find((r) => r.runId === 'fresh-run')?.status).toBe('running')
  })

  it('skips in-memory active runs during stale reconciliation', async () => {
    const staleAt = new Date(Date.now() - 3 * 60_000).toISOString()
    writeStatus(resolveRunDir(workspace, 'live-run'), {
      status: 'running',
      updatedAt: staleAt,
      goal: 'live',
      workspacePath: workspace
    })
    registerRunAbort('live-run', new AbortController(), workspace, 1)

    const result = await listRuns(workspace)
    expect(result.runs.find((r) => r.runId === 'live-run')?.status).toBe('running')

    clearRunAbort('live-run')
  })

  it('syncMessages rewrites messages.jsonl from client history', () => {
    const runId = 'sync-run'
    const dir = createRun(workspace, runId, 'sync test')
    const messages = [
      { role: 'user' as const, content: 'one' },
      { role: 'assistant' as const, content: 'two' },
      { role: 'user' as const, content: 'three' }
    ]

    syncMessages(dir, messages)

    expect(loadMessages(workspace, runId)).toEqual(messages)
  })

  it('renames run goal atomically in status and contract', async () => {
    const runId = 'rename-run'
    const dir = createRun(workspace, runId, 'old goal')
    writeFileSync(join(dir, 'contract.md'), '# Run contract\n\n## Goal\n\nold goal\n\n## Done when\n\nx\n', 'utf8')
    const summary = await renameRun(workspace, runId, 'new goal')
    expect(summary.goal).toBe('new goal')
    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as { goal?: string }
    expect(status.goal).toBe('new goal')
    expect(readFileSync(join(dir, 'contract.md'), 'utf8')).toContain('new goal')
  })

  it('leaves the contract goal section untouched when no section header matches (async read path)', async () => {
    // Audit L-15 made both reads async; the no-match branch must stay
    // byte-identical — contract written back unchanged when GOAL_SECTION_RE
    // does not match.
    const runId = 'rename-no-section'
    const dir = createRun(workspace, runId, 'old goal')
    const contract = '# Run contract\n\nNo goal section here\n'
    writeFileSync(join(dir, 'contract.md'), contract, 'utf8')
    await renameRun(workspace, runId, 'renamed goal')
    expect(readFileSync(join(dir, 'contract.md'), 'utf8')).toBe(contract)
  })

  it('rejects rename when status.json is schema-invalid on the async read path', async () => {
    // Parsable JSON that fails RunStatusSchema must hit the explicit
    // 'Invalid run status' rejection — same shape as before audit L-15.
    const runId = 'rename-invalid-status'
    const dir = createRun(workspace, runId, 'old goal')
    writeFileSync(join(dir, 'status.json'), '{"nonsense": true}', 'utf8')
    await expect(renameRun(workspace, runId, 'new goal')).rejects.toThrow('Invalid run status')
  })
})
