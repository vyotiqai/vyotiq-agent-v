/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearOfflineQueue,
  dequeueOfflineMessage,
  enqueueOfflineMessage,
  offlineQueueLength,
  peekOfflineQueue,
  removeOfflineQueueEntriesForRun,
  resolveOfflineFlushTarget
} from '@renderer/lib/hooks/offlineQueueStore'

const WORKSPACE = '/tmp/vyotiq-offline-ws'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-uuid'
  })
})

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('offlineQueueStore', () => {
  it('enqueues FIFO per workspace and persists in localStorage', () => {
    enqueueOfflineMessage(WORKSPACE, { text: 'first' })
    enqueueOfflineMessage(WORKSPACE, { text: 'second' })

    expect(offlineQueueLength(WORKSPACE)).toBe(2)
    expect(peekOfflineQueue(WORKSPACE)?.text).toBe('first')

    const key = `vyotiq.offlineQueue.${encodeURIComponent(WORKSPACE)}`
    expect(localStorage.getItem(key)).toContain('"first"')
    expect(localStorage.getItem(key)).toContain('"second"')
  })

  it('dequeues in FIFO order and clears storage when empty', () => {
    enqueueOfflineMessage(WORKSPACE, { text: 'a' })
    enqueueOfflineMessage(WORKSPACE, { text: 'b' })

    expect(dequeueOfflineMessage(WORKSPACE)?.text).toBe('a')
    expect(dequeueOfflineMessage(WORKSPACE)?.text).toBe('b')
    expect(dequeueOfflineMessage(WORKSPACE)).toBeNull()
    expect(offlineQueueLength(WORKSPACE)).toBe(0)

    const key = `vyotiq.offlineQueue.${encodeURIComponent(WORKSPACE)}`
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('isolates queues by workspace path', () => {
    enqueueOfflineMessage('/ws/a', { text: 'alpha' })
    enqueueOfflineMessage('/ws/b', { text: 'beta' })

    expect(peekOfflineQueue('/ws/a')?.text).toBe('alpha')
    expect(peekOfflineQueue('/ws/b')?.text).toBe('beta')
    expect(offlineQueueLength('/ws/a')).toBe(1)
    expect(offlineQueueLength('/ws/b')).toBe(1)
  })

  it('survives a simulated restart by re-reading localStorage', () => {
    enqueueOfflineMessage(WORKSPACE, { text: 'persist me', images: ['img://1'] })
    expect(offlineQueueLength(WORKSPACE)).toBe(1)

    // New module load would re-read the same localStorage key.
    expect(peekOfflineQueue(WORKSPACE)?.images).toEqual(['img://1'])
  })

  it('clearOfflineQueue removes all pending sends', () => {
    enqueueOfflineMessage(WORKSPACE, { text: 'one' })
    enqueueOfflineMessage(WORKSPACE, { text: 'two' })
    clearOfflineQueue(WORKSPACE)
    expect(offlineQueueLength(WORKSPACE)).toBe(0)
    expect(peekOfflineQueue(WORKSPACE)).toBeNull()
  })

  it('removeOfflineQueueEntriesForRun drops only matching run ids', () => {
    enqueueOfflineMessage(WORKSPACE, { text: 'keep-draft', runId: null })
    enqueueOfflineMessage(WORKSPACE, { text: 'drop-me', runId: 'run-a' })
    enqueueOfflineMessage(WORKSPACE, { text: 'keep-other', runId: 'run-b' })
    removeOfflineQueueEntriesForRun(WORKSPACE, 'run-a')
    expect(offlineQueueLength(WORKSPACE)).toBe(2)
    expect(peekOfflineQueue(WORKSPACE)?.text).toBe('keep-draft')
    dequeueOfflineMessage(WORKSPACE)
    expect(peekOfflineQueue(WORKSPACE)?.text).toBe('keep-other')
  })
})

describe('resolveOfflineFlushTarget', () => {
  const panes = [
    { paneId: 'pane-a', workspacePath: '/ws-a', runId: 'run-a' },
    { paneId: 'pane-draft', workspacePath: '/ws-a', runId: null }
  ]

  it('uses the stored pane even after the pane runId is promoted', () => {
    const target = resolveOfflineFlushTarget(
      { id: '1', text: 'draft', runId: null, paneId: 'pane-draft', queuedAt: '' },
      [{ paneId: 'pane-draft', workspacePath: '/ws-a', runId: 'run-new' }]
    )
    expect(target).toEqual({ workspacePath: '/ws-a', runId: 'run-new' })
  })

  it('does not resolve runId null from a focused sibling pane', () => {
    const target = resolveOfflineFlushTarget(
      { id: '1', text: 'draft', runId: null, queuedAt: '' },
      panes
    )
    expect(target).toBeNull()
  })

  it('binds a concrete runId to the stored workspace, not the focused pane', () => {
    const target = resolveOfflineFlushTarget(
      {
        id: '1',
        text: 'bound',
        runId: 'run-b',
        workspacePath: '/ws-b',
        queuedAt: ''
      },
      panes,
      '/ws-a'
    )
    expect(target).toEqual({ workspacePath: '/ws-b', runId: 'run-b' })
  })

  it('falls back to the queue workspace for legacy entries that only stored runId', () => {
    const target = resolveOfflineFlushTarget(
      { id: '1', text: 'legacy', runId: 'run-a', queuedAt: '' },
      panes,
      '/ws-a'
    )
    expect(target).toEqual({ workspacePath: '/ws-a', runId: 'run-a' })
  })
})
