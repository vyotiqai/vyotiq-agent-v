/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReviewDiffTable, type HunkActions } from '@renderer/features/inspector/ReviewDiffTable'
import { ChangesPanel } from '@renderer/features/chat/components/ChangesPanel'
import { getToasts, resetToastStoreForTests } from '@renderer/lib/ui/toastStore'
import { diffFingerprint, hunkIdentity, parseUnifiedHunks } from '@shared/utils/hunkPatch'
import type { UiItem } from '@shared/transcript'

const TWO_HUNKS = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  ' four',
  '@@ -20,3 +20,4 @@ function tail() {',
  ' twenty',
  '+twenty and a half',
  ' twenty-one',
  ' twenty-two',
  ''
].join('\n')

const SWAP_DIFF = [
  '--- a/src/swap.ts',
  '+++ b/src/swap.ts',
  '@@ -1,4 +1,5 @@',
  ' export async function swapStaged() {',
  '   await prepare()',
  '+  await closeStagingWatcher()',
  '   await rename(staged, target)',
  ' }',
  ''
].join('\n')

const identityOf = (diff: string, index: number) => hunkIdentity(parseUnifiedHunks(diff)[index]!)

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('ReviewDiffTable hunk actions', () => {
  it('names each hunk by position and content, with the fingerprint of the diff on screen', () => {
    const onUndo = vi.fn()
    render(<ReviewDiffTable path="src/a.ts" diff={TWO_HUNKS} layout="unified" hunkActions={{ onUndo }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Undo the hunk at line 20' }))
    expect(onUndo).toHaveBeenCalledWith({
      path: 'src/a.ts',
      hunk: identityOf(TWO_HUNKS, 1),
      diffHash: diffFingerprint(TWO_HUNKS)
    })
    expect(identityOf(TWO_HUNKS, 1)).toMatchObject({ oldStart: 20, oldLines: 3, newStart: 20, newLines: 4 })
  })

  it('keeps the +/− gutter signs on the lines under a hunk with actions', () => {
    const { container } = render(
      <ReviewDiffTable path="src/a.ts" diff={TWO_HUNKS} layout="unified" hunkActions={{ onUndo: vi.fn() }} />
    )
    const del = container.querySelector('[data-diff-line="del"]') as HTMLElement
    const add = container.querySelector('[data-diff-line="add"]') as HTMLElement
    expect(del.textContent).toContain('−')
    expect(add.textContent).toContain('+')
    expect(container.querySelectorAll('[data-hunk]')).toHaveLength(2)
  })

  it('offers the same actions side by side', () => {
    const onUndo = vi.fn()
    render(<ReviewDiffTable path="src/a.ts" diff={TWO_HUNKS} layout="split" hunkActions={{ onUndo }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Undo the hunk at line 1' }))
    expect(onUndo.mock.calls[0]![0].hunk).toEqual(identityOf(TWO_HUNKS, 0))
  })

  it('stays in the tab order while hidden, and says why it cannot run during a live run', () => {
    render(
      <ReviewDiffTable
        path="src/a.ts"
        diff={TWO_HUNKS}
        layout="unified"
        hunkActions={{ onUndo: vi.fn(), blockedReason: 'Stop the run to undo part of a file' }}
      />
    )
    const undo = screen.getByRole('button', { name: 'Undo the hunk at line 1' }) as HTMLButtonElement
    expect(undo.disabled).toBe(true)
    // Hidden by opacity, never by display: a keyboard still reaches the enabled ones.
    expect(undo.closest('.opacity-0')).toBeTruthy()
    expect(undo.closest('.hidden')).toBeNull()
  })

  it('gives a new file none: it is one hunk, the file’s own Undo', () => {
    const created = '--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n'
    render(<ReviewDiffTable path="n.ts" diff={created} layout="unified" hunkActions={{ onUndo: vi.fn() }} />)
    expect(screen.queryByRole('button', { name: /Undo the hunk/ })).toBeNull()
  })

  it('marks a hunk viewed as a pressed toggle that stays visible', () => {
    const viewed = new Set<string>()
    const actions = (): HunkActions => ({
      onUndo: vi.fn(),
      isViewed: (t) => viewed.has(t.hunk.hash),
      onViewed: (t, next) => (next ? viewed.add(t.hunk.hash) : viewed.delete(t.hunk.hash))
    })
    const { rerender } = render(<ReviewDiffTable path="src/a.ts" diff={TWO_HUNKS} layout="unified" hunkActions={actions()} />)
    const toggle = screen.getByRole('button', { name: 'Mark the hunk at line 1 viewed' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    rerender(<ReviewDiffTable path="src/a.ts" diff={TWO_HUNKS} layout="unified" hunkActions={actions()} />)
    const pressed = screen.getByRole('button', { name: 'Mark the hunk at line 1 viewed' })
    expect(pressed.getAttribute('aria-pressed')).toBe('true')
    expect(pressed.closest('.opacity-0')).toBeNull()
  })
})

describe('ChangesPanel hunk Undo', () => {
  beforeEach(() => {
    resetToastStoreForTests()
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'not_repo' } }),
        gitDiff: vi.fn().mockResolvedValue({ ok: true, data: { content: '' } }),
        taskFileStats: vi.fn().mockResolvedValue({
          ok: true,
          data: { files: [{ path: 'src/swap.ts', action: 'modified', add: 1, del: 0 }] }
        }),
        taskFileDiff: vi.fn().mockResolvedValue({
          ok: true,
          data: { path: 'src/swap.ts', action: 'modified', diff: SWAP_DIFF, add: 1, del: 0 }
        }),
        undoHunk: vi.fn().mockResolvedValue({ ok: true, data: { path: 'src/swap.ts', restoreToken: 'tok-1' } }),
        restoreHunk: vi.fn().mockResolvedValue({ ok: true, data: { path: 'src/swap.ts' } })
      }
    })
  })

  // The shape the Changes tests feed it: an edit's tool row as the transcript first had it.
  const items = [
    { kind: 'message', id: 'u1', role: 'user', content: 'fix', at: 1 },
    {
      kind: 'tool',
      id: 'r1',
      at: 2,
      tool: {
        toolCallId: 'r1',
        name: 'str_replace',
        status: 'done',
        summary: 'src/swap.ts',
        argsPreview: JSON.stringify({
          path: 'src/swap.ts',
          old_string: '  await rename(staged, target)',
          new_string: '  await closeStagingWatcher()\n  await rename(staged, target)'
        })
      }
    }
  ] as unknown as UiItem[]

  it('sends the hunk’s identity to main, refreshes, and offers Restore', async () => {
    const onGitMutated = vi.fn()
    render(
      <ChangesPanel
        items={items}
        workspacePath="/ws"
        gitRevision={1}
        runId="run-1"
        variant="review"
        canResolve
        resolvablePaths={new Set(['src/swap.ts'])}
        onGitMutated={onGitMutated}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Undo the hunk at line 1' }))
    await waitFor(() =>
      expect(window.vyotiq.undoHunk).toHaveBeenCalledWith({
        workspacePath: '/ws',
        runId: 'run-1',
        path: 'src/swap.ts',
        hunk: identityOf(SWAP_DIFF, 0),
        diffHash: diffFingerprint(SWAP_DIFF)
      })
    )
    await waitFor(() => expect(onGitMutated).toHaveBeenCalled())
    const toast = getToasts().find((t) => t.message === 'Undid one hunk')
    expect(toast?.action?.label).toBe('Restore')
    toast!.action!.onClick()
    await waitFor(() =>
      expect(window.vyotiq.restoreHunk).toHaveBeenCalledWith({ workspacePath: '/ws', runId: 'run-1', restoreToken: 'tok-1' })
    )
  })

  it('offers no hunk Undo once the file is kept', async () => {
    render(
      <ChangesPanel
        items={items}
        workspacePath="/ws"
        gitRevision={1}
        runId="run-1"
        variant="review"
        canResolve
        resolvablePaths={new Set(['src/swap.ts'])}
        writeFileResolutions={new Map([['src/swap.ts', 'kept' as const]])}
      />
    )
    await waitFor(() => expect(document.querySelector('[data-review-diff]')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Undo the hunk/ })).toBeNull()
  })
})
