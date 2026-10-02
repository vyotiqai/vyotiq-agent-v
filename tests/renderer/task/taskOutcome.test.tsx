/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TaskOutcome } from '@shared/ipc'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { RecordActionsContext } from '@renderer/features/task/record/WorkItems'
import { RunSessionProvider, type RunSessionValue } from '@renderer/features/chat/RunSessionContext'
import { bumpTaskOutcome, outcomeMarks, summarizeOutcome } from '@renderer/features/task/taskOutcomeStore'
import { createChatStreamController } from '@renderer/lib/hooks/createChatStreamController'
import { takeCommitRequest } from '@renderer/features/chat/commitRequest'

/**
 * Once a task's edits are settled, the record says how on one line, and each
 * file under the result carries its Kept or Undone.
 */

const SHA = 'abc1234def5678abc1234def5678abc1234def56'

describe('summarizeOutcome', () => {
  const files = (...marks: Array<'kept' | 'undone' | 'pending'>): TaskOutcome['files'] =>
    marks.map((mark, i) => ({ path: `f${i}.ts`, mark }))

  it('says nothing while a file waits on review, or when nothing was written', () => {
    expect(summarizeOutcome({ files: files('kept', 'pending') })).toBeNull()
    expect(summarizeOutcome({ files: [] })).toBeNull()
    expect(summarizeOutcome(null)).toBeNull()
  })

  it('names the commit first, then kept, undone, or both counted', () => {
    const commit = { sha: SHA, branch: 'main', at: '2026-09-30T00:00:00.000Z', pushed: false }
    expect(summarizeOutcome({ files: files('kept', 'undone'), commit })).toEqual({
      kind: 'committed',
      sha: SHA,
      branch: 'main',
      undone: 1
    })
    expect(summarizeOutcome({ files: files('kept', 'kept') })).toEqual({ kind: 'kept' })
    expect(summarizeOutcome({ files: files('undone') })).toEqual({ kind: 'undone' })
    expect(summarizeOutcome({ files: files('kept', 'kept', 'undone') })).toEqual({ kind: 'mixed', kept: 2, undone: 1 })
  })

  it('marks only what was decided', () => {
    expect([...outcomeMarks({ files: files('kept', 'pending', 'undone') })]).toEqual([
      ['f0.ts', 'kept'],
      ['f2.ts', 'undone']
    ])
  })
})

const at = (s: number): string => new Date(Date.parse('2026-09-30T09:00:00.000Z') + s * 1000).toISOString()
const edit = (path: string, s: number): UiItem => ({
  kind: 'tool',
  id: `t-${path}`,
  at: at(s),
  endedAt: at(s + 1),
  tool: {
    id: `c-${path}`,
    name: 'edit',
    summary: path,
    status: 'done',
    content: `Updated ${path}`,
    argsPreview: JSON.stringify({ path, diff: '@@ -1 +1 @@\n-a\n+b' })
  }
})
const run: UiItem[] = [
  { kind: 'message', id: 'user-0', role: 'user', content: 'Fix it', at: at(0) },
  edit('src/a.ts', 1),
  edit('src/b.ts', 3),
  { kind: 'message', id: 'a-1', role: 'assistant', content: 'Fixed.', at: at(5) }
]

function showRecord(
  outcome: TaskOutcome,
  pending = 0,
  inspector: { onOpenPanel?: RunSessionValue['onOpenPanel']; onOpenChanges?: () => void } = {}
) {
  window.vyotiq = { taskOutcome: vi.fn().mockResolvedValue({ ok: true, data: outcome }) } as unknown as typeof window.vyotiq
  const options: BuildOptions = { running: false }
  return render(
    <RunSessionProvider
      value={{
        workspacePath: '/ws',
        runId: 'r1',
        pendingWrites: pending > 0 ? { runId: 'r1', count: pending, onUndo: vi.fn() } : undefined,
        onOpenPanel: inspector.onOpenPanel
      }}
    >
      <RecordActionsContext.Provider value={{ onOpenChanges: inspector.onOpenChanges ?? vi.fn() }}>
        <TaskRecord model={buildRecordModel(run, options)} options={options} messageCount={run.length} />
      </RecordActionsContext.Provider>
    </RunSessionProvider>
  )
}

describe('the result once its edits are settled', () => {
  beforeEach(() => bumpTaskOutcome())
  afterEach(cleanup)

  it('says which commit took them, and marks each file', async () => {
    const { container } = showRecord({
      files: [
        { path: 'src/a.ts', mark: 'kept' },
        { path: 'src/b.ts', mark: 'kept' }
      ],
      commit: { sha: SHA, branch: 'main', at: at(9), pushed: false }
    })
    await waitFor(() => {
      expect(container.querySelector('[data-result-outcome]')?.textContent).toBe('Committed abc1234 to main')
    })
    expect([...container.querySelectorAll('[data-result-file-mark]')].map((m) => m.textContent)).toEqual(['Kept', 'Kept'])
  })

  it('says Kept, not committed yet; Undone; or counts a mix, and strikes an undone file', async () => {
    const kept = showRecord({ files: [{ path: 'src/a.ts', mark: 'kept' }, { path: 'src/b.ts', mark: 'kept' }] })
    await waitFor(() => {
      expect(kept.container.querySelector('[data-result-outcome="kept"]')?.textContent).toBe('Kept, not committed yet')
    })
    kept.unmount()
    bumpTaskOutcome()
    const mixed = showRecord({ files: [{ path: 'src/a.ts', mark: 'kept' }, { path: 'src/b.ts', mark: 'undone' }] })
    await waitFor(() => {
      expect(mixed.container.querySelector('[data-result-outcome="mixed"]')?.textContent).toBe(
        '1 kept, 1 undone, not committed yet'
      )
    })
    const undoneRow = mixed.container.querySelector('[data-result-file-mark="undone"]')!.closest('button')!
    expect(undoneRow.textContent).toContain('Undone')
    expect(undoneRow.querySelector('.line-through')?.textContent).toBe('b.ts')
    mixed.unmount()
    bumpTaskOutcome()
    const undone = showRecord({ files: [{ path: 'src/a.ts', mark: 'undone' }, { path: 'src/b.ts', mark: 'undone' }] })
    await waitFor(() => {
      expect(undone.container.querySelector('[data-result-outcome="undone"]')?.textContent).toBe(
        'Undone — the files are back as they were'
      )
    })
  })

  it('offers the next step on the inspector’s own run: Commit… for kept edits, Pull request after a commit', async () => {
    const onOpenPanel = vi.fn()
    const onOpenChanges = vi.fn()
    const kept = showRecord({ files: [{ path: 'src/a.ts', mark: 'kept' }, { path: 'src/b.ts', mark: 'kept' }] }, 0, {
      onOpenPanel,
      onOpenChanges
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Commit…' }))
    expect(onOpenChanges).toHaveBeenCalledTimes(1)
    // The ask waits for that task's Changes to take it, and only once.
    expect(takeCommitRequest('other-run')).toBe(false)
    expect(takeCommitRequest('r1')).toBe(true)
    expect(takeCommitRequest('r1')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Pull request' })).toBeNull()
    kept.unmount()
    bumpTaskOutcome()

    showRecord(
      { files: [{ path: 'src/a.ts', mark: 'kept' }], commit: { sha: SHA, branch: 'main', at: at(9), pushed: true } },
      0,
      { onOpenPanel, onOpenChanges }
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Pull request' }))
    expect(onOpenPanel).toHaveBeenCalledWith('pr')
    expect(screen.queryByRole('button', { name: 'Commit…' })).toBeNull()
  })

  it('offers neither where the inspector shows another run', async () => {
    showRecord({ files: [{ path: 'src/a.ts', mark: 'kept' }] })
    await waitFor(() => {
      expect(document.querySelector('[data-result-outcome="kept"]')).not.toBeNull()
    })
    expect(screen.queryByRole('button', { name: 'Commit…' })).toBeNull()
  })

  it('says nothing settled while a file still waits on review', async () => {
    const { container } = showRecord(
      { files: [{ path: 'src/a.ts', mark: 'kept' }, { path: 'src/b.ts', mark: 'pending' }] },
      1
    )
    await waitFor(() => {
      expect(container.querySelector('[data-result-file-mark="kept"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-result-outcome]')).toBeNull()
    expect(container.querySelector('[data-result-review]')?.textContent).toContain('1 file changed, not kept yet')
  })
})

describe('a taken-back Keep or Undo on the live task', () => {
  it('puts the files back to waiting, even after a reload dropped the settled checkpoint', () => {
    window.vyotiq = {} as unknown as typeof window.vyotiq
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    expect(controller.writeCheckpoint).toBeNull()
    controller.applyWriteCheckpointReopen({
      reopened: ['a.ts'],
      checkpoints: [
        {
          checkpointId: 'cp-1',
          files: [
            { path: 'a.ts', action: 'modified', undoable: true },
            { path: 'b.ts', action: 'modified', undoable: true, resolved: 'kept' }
          ]
        }
      ]
    })
    expect(controller.writeCheckpoint).toEqual({
      checkpointId: 'cp-1',
      undone: false,
      files: [{ path: 'a.ts', action: 'modified', undoable: true }]
    })
  })

  it('clears the mark on a file the live checkpoint holds as kept', () => {
    window.vyotiq = {} as unknown as typeof window.vyotiq
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({
      type: 'writes_checkpoint',
      runId: 'r1',
      checkpointId: 'cp-2',
      undone: true,
      files: [{ path: 'a.ts', action: 'modified', undoable: true, resolved: 'kept' }]
    } as never)
    controller.applyWriteCheckpointReopen({
      reopened: ['a.ts'],
      checkpoints: [{ checkpointId: 'cp-2', files: [{ path: 'a.ts', action: 'modified', undoable: true }] }]
    })
    expect(controller.writeCheckpoint?.undone).toBe(false)
    expect(controller.writeCheckpoint?.files[0]?.resolved).toBeUndefined()
  })
})
