/**
 * @vitest-environment jsdom
 *
 * Regression tests for the changes/revert/checkpoints audit fix:
 * hydration must let the NEWEST writes_checkpoint row per checkpoint id win,
 * so a stale unresolved row cannot resurrect a resolved/undone banner after
 * a Keep/Discard/Undo (persistWriteCheckpointEvent appends a second row with
 * the same checkpointId). Uses the real createChatStreamController; only the
 * preload bridge is faked.
 */
import { describe, expect, it, vi } from 'vitest'
import { createChatStreamController } from '@renderer/lib/hooks/createChatStreamController'

function cpEvent(opts: {
  checkpointId: string
  path: string
  undone?: boolean
  resolved?: 'kept' | 'discarded'
  conflicted?: boolean
}): unknown {
  return {
    at: '2026-01-01T00:00:00.000Z',
    event: {
      type: 'writes_checkpoint',
      runId: 'r1',
      checkpointId: opts.checkpointId,
      ...(opts.undone !== undefined ? { undone: opts.undone } : {}),
      files: [
        {
          path: opts.path,
          action: 'modified' as const,
          undoable: true,
          ...(opts.resolved ? { resolved: opts.resolved } : {}),
          ...(opts.conflicted ? { conflicted: opts.conflicted } : {})
        }
      ]
    }
  }
}

function setupBridge(events: unknown[]): void {
  const listActiveRuns = vi.fn().mockResolvedValue({ ok: true, data: [] })
  const loadRun = vi.fn().mockResolvedValue({
    ok: true,
    data: { messages: [], status: 'done' }
  })
  const loadRunEvents = vi.fn().mockResolvedValue({ ok: true, data: events })
  // @ts-expect-error test bridge
  window.vyotiq = {
    listActiveRuns,
    loadRun,
    loadRunEvents
  }
}

describe('writes_checkpoint hydration (newest-row-wins regression)', () => {
  it('stale unresolved row is superseded by a later undone row for the same id', async () => {
    // Real sequence: turn writes cp-1 (append), user Undoes (persistWriteCheckpointEvent
    // appends a second cp-1 row with undone: true). On reload, BOTH rows are present.
    setupBridge([
      cpEvent({ checkpointId: 'cp-1', path: 'a.ts' }),
      cpEvent({ checkpointId: 'cp-1', path: 'a.ts', undone: true })
    ])
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    await controller.syncFromDisk('r1')
    expect(controller.writeCheckpoint).toBeNull()
  })

  it('duplicate pre-resolution row does NOT resurrect a resolved banner', async () => {
    // Real sequence: turn writes cp-1; user keeps a.ts (persist appends cp-1 with
    // files[0].resolved='kept'); a pre-existing duplicate of the ORIGINAL row also
    // remains in the tail (e.g. from collectLatestCriticalEvents dedupe window or
    // an earlier persist). The resolved row must win as the latest per id.
    setupBridge([
      cpEvent({ checkpointId: 'cp-1', path: 'a.ts' }),
      cpEvent({ checkpointId: 'cp-1', path: 'a.ts', resolved: 'kept' })
    ])
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    await controller.syncFromDisk('r1')
    expect(controller.writeCheckpoint).toBeNull()
  })

  it('two distinct unresolved checkpoints merge into one banner (newest id wins)', async () => {
    setupBridge([
      cpEvent({ checkpointId: 'cp-old', path: 'a.ts' }),
      cpEvent({ checkpointId: 'cp-new', path: 'b.ts' })
    ])
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    await controller.syncFromDisk('r1')
    expect(controller.writeCheckpoint?.checkpointId).toBe('cp-new')
    expect(controller.writeCheckpoint?.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts'])
    expect(controller.writeCheckpoint?.undone).toBe(false)
  })

  it('fully-resolved-by-flags checkpoint does not show a banner', async () => {
    setupBridge([
      cpEvent({ checkpointId: 'cp-1', path: 'a.ts', resolved: 'kept' })
    ])
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    await controller.syncFromDisk('r1')
    // All files resolved → banner suppressed even though row.undone is absent.
    expect(controller.writeCheckpoint).toBeNull()
  })

  it('conflicted state survives reload so "Edited since" stays visible', async () => {
    setupBridge([
      cpEvent({ checkpointId: 'cp-1', path: 'a.ts', conflicted: true })
    ])
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    await controller.syncFromDisk('r1')
    expect(controller.writeCheckpoint?.files[0]?.conflicted).toBe(true)
  })
})
