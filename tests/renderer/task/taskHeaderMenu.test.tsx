/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { TaskPane, type TaskPaneProps } from '@renderer/features/task/TaskPane'
import { getToasts, resetToastStoreForTests } from '@renderer/lib/ui/toastStore'
import { RUN_LIST_CHANGED_EVENT } from '@renderer/lib/chat/runListSignal'

/**
 * The task header's ⋯ offers the record's own way on — Retry where its error
 * row offers it, Resume where its receipt does — and says why a live task
 * can't be archived instead of hiding Archive.
 */

beforeEach(() => {
  window.vyotiq = {
    readRunArtifact: vi.fn().mockResolvedValue({ ok: true, data: { exists: false, content: '' } })
  } as unknown as typeof window.vyotiq
})
afterEach(cleanup)

const T0 = Date.parse('2026-10-01T09:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

const brief: UiItem = { kind: 'message', id: 'user-0', role: 'user', content: 'Fix the parser', at: at(0) }
const lookup: UiItem = {
  kind: 'tool',
  id: 't-1',
  at: at(1),
  endedAt: at(2),
  tool: { id: 'c-1', name: 'read', summary: 'src/parse.ts', status: 'done', content: 'contents', argsPreview: '{"path":"src/parse.ts"}' }
}
const failure: UiItem = { kind: 'run_error', id: 'err-1', at: at(3), message: 'The provider timed out', code: 'PROVIDER_TIMEOUT' }
const fatal: UiItem = { kind: 'run_error', id: 'err-2', at: at(3), message: 'The model is not set up', code: 'CONFIG_INVALID' }

function pane(over: Partial<TaskPaneProps>) {
  const props: TaskPaneProps = {
    workspacePath: '/ws',
    runId: 'r1',
    items: [brief, lookup],
    running: false,
    pendingRun: false,
    turnFailed: false,
    turnStatus: 'done',
    compacting: false,
    showThinking: false,
    run: null,
    onStop: vi.fn(),
    actions: { onToggleArchive: vi.fn(), isArchived: () => false, onRename: vi.fn() },
    messageCount: 1,
    composer: null,
    onRetry: vi.fn(),
    ...over
  }
  render(<TaskPane {...props} />)
  fireEvent.click(screen.getByRole('button', { name: /^More — / }))
  return { props, items: screen.getAllByRole('menuitem') }
}

describe('the task header menu', () => {
  it('leads with Resume on a stopped task, and Resume continues it as the record does', () => {
    const { props, items } = pane({ turnStatus: 'cancelled' })
    expect(items[0]!.textContent).toBe('Resume')
    fireEvent.click(items[0]!)
    expect(props.onRetry).toHaveBeenCalledTimes(1)
  })

  it('leads with Retry on a failed one', () => {
    const { props, items } = pane({ items: [brief, lookup, failure], turnFailed: true, turnStatus: 'error' })
    expect(items[0]!.textContent).toBe('Retry')
    expect(items.map((i) => i.textContent)).not.toContain('Resume')
    fireEvent.click(items[0]!)
    expect(props.onRetry).toHaveBeenCalledTimes(1)
  })

  it('offers neither on a failure Retry can’t get past, as its error row offers none', () => {
    const { items } = pane({ items: [brief, lookup, fatal], turnFailed: true, turnStatus: 'error' })
    const labels = items.map((i) => i.textContent)
    expect(labels).not.toContain('Retry')
    expect(labels).not.toContain('Resume')
  })

  it('offers neither on a finished task', () => {
    const { items } = pane({})
    const labels = items.map((i) => i.textContent)
    expect(labels).not.toContain('Resume')
    expect(labels).not.toContain('Retry')
  })

  it('greys out Archive while the task works, and says why', () => {
    const { props } = pane({ running: true, turnStatus: null })
    const archive = screen.getByRole('menuitem', { name: 'Archive' }) as HTMLButtonElement
    expect(archive.disabled).toBe(true)
    expect(archive.getAttribute('title')).toBe('Stop it or let it finish first')
    fireEvent.click(archive)
    expect(props.actions.onToggleArchive).not.toHaveBeenCalled()
  })
})

describe('the task header menu’s folders', () => {
  const run = (extraRoots?: string[]) => ({
    runId: 'r1',
    status: 'done' as const,
    updatedAt: at(4),
    goal: 'Fix the parser',
    ...(extraRoots ? { extraRoots } : {})
  })

  afterEach(() => resetToastStoreForTests())

  it('adds a folder to a started task through main, and says when it takes hold', async () => {
    const setRunExtraRoots = vi.fn(async () => ({
      ok: true as const,
      data: { extraRoots: ['/srv/api'], live: true, added: '/srv/api' }
    }))
    window.vyotiq.setRunExtraRoots = setRunExtraRoots as unknown as typeof window.vyotiq.setRunExtraRoots
    const changed = vi.fn()
    window.addEventListener(RUN_LIST_CHANGED_EVENT, changed)
    try {
      pane({ run: run() as TaskPaneProps['run'], running: true, turnStatus: null })
      fireEvent.click(screen.getByRole('menuitem', { name: 'Add folder…' }))
      await waitFor(() => expect(setRunExtraRoots).toHaveBeenCalledWith({ action: 'add', workspacePath: '/ws', runId: 'r1' }))
      await waitFor(() => expect(getToasts().map((t) => t.message)).toContain('Added api'))
      expect(getToasts()[0]!.detail).toContain('when it next starts')
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(RUN_LIST_CHANGED_EVENT, changed)
    }
  })

  it('removes one of its folders, and offers no more than the limit', async () => {
    const setRunExtraRoots = vi.fn(async () => ({
      ok: true as const,
      data: { extraRoots: [], live: false, removed: '/srv/api' }
    }))
    window.vyotiq.setRunExtraRoots = setRunExtraRoots as unknown as typeof window.vyotiq.setRunExtraRoots
    pane({ run: run(['/srv/api']) as TaskPaneProps['run'] })
    const remove = screen.getByRole('menuitem', { name: /^Remove api/ })
    expect(remove.textContent).toContain('/srv/api')
    fireEvent.click(remove)
    await waitFor(() =>
      expect(setRunExtraRoots).toHaveBeenCalledWith({ action: 'remove', workspacePath: '/ws', runId: 'r1', root: '/srv/api' })
    )
    await waitFor(() => expect(getToasts().map((t) => t.message)).toContain('Removed api'))
    cleanup()

    pane({ run: run(['/a/1', '/a/2', '/a/3', '/a/4', '/a/5']) as TaskPaneProps['run'] })
    expect((screen.getByRole('menuitem', { name: 'Add folder…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says why main refused a folder', async () => {
    window.vyotiq.setRunExtraRoots = vi.fn(async () => ({
      ok: true as const,
      data: { extraRoots: [], live: false, refused: '/ws/lib: already part of the workspace' }
    })) as unknown as typeof window.vyotiq.setRunExtraRoots
    pane({ run: run() as TaskPaneProps['run'] })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add folder…' }))
    await waitFor(() =>
      expect(getToasts().map((t) => t.message)).toContain('Can’t add /ws/lib: already part of the workspace')
    )
  })

  it('leaves a helper instance on its parent’s folders', () => {
    window.vyotiq.setRunExtraRoots = vi.fn() as unknown as typeof window.vyotiq.setRunExtraRoots
    pane({ run: { ...run(), inlineInstance: true } as TaskPaneProps['run'] })
    expect(screen.queryByRole('menuitem', { name: 'Add folder…' })).toBeNull()
  })
})
