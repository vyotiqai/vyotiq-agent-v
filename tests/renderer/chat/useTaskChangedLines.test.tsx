/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { addedLineNumbers, useTaskChangedLines } from '@renderer/features/chat/components/useTaskChangedLines'

const DIFF = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,4 @@', ' one', '-two', '+TWO', '+two and a half', ' three', '@@ -10,2 +11,2 @@', ' ten', '+eleven', '-old eleven'].join('\n')

afterEach(() => {
  cleanup()
  ;(window as unknown as { vyotiq?: unknown }).vyotiq = undefined
})

describe('addedLineNumbers', () => {
  it('reads the new-side numbers of the added lines, hunk by hunk', () => {
    expect(addedLineNumbers(DIFF)).toEqual([2, 3, 12])
    expect(addedLineNumbers('')).toEqual([])
  })

  it('marks none of a diff past the cap, never just its first part', () => {
    const huge = ['@@ -0,0 +1,6000 @@', ...Array.from({ length: 6000 }, (_, i) => `+line ${i}`)].join('\n')
    expect(addedLineNumbers(huge)).toEqual([])
  })
})

describe('useTaskChangedLines', () => {
  it('asks the task’s record only for a file it changed, and again when the file moves', async () => {
    const taskFileDiff = vi.fn(async () => ({ ok: true, data: { path: 'a.ts', action: 'modified', diff: DIFF } }))
    ;(window as unknown as { vyotiq: unknown }).vyotiq = { taskFileDiff }
    const args = { workspacePath: 'C:/ws', runId: 'run-1', path: 'a.ts', changed: true, revision: '0:abc' }
    const hook = renderHook((p: typeof args) => useTaskChangedLines(p), { initialProps: args })
    await waitFor(() => expect(hook.result.current).toEqual([2, 3, 12]))
    expect(taskFileDiff).toHaveBeenCalledWith({ workspacePath: 'C:/ws', runId: 'run-1', path: 'a.ts' })

    hook.rerender({ ...args, revision: '0:def' })
    await waitFor(() => expect(taskFileDiff).toHaveBeenCalledTimes(2))

    // A file the task only read: nothing to mark, nothing asked.
    hook.rerender({ ...args, path: 'b.ts', changed: false })
    expect(hook.result.current).toBeNull()
    expect(taskFileDiff).toHaveBeenCalledTimes(2)
  })

  it('marks nothing for a rewrite shown as one replacement', async () => {
    const taskFileDiff = vi.fn(async () => ({ ok: true, data: { path: 'a.ts', action: 'modified', diff: DIFF, full: true } }))
    ;(window as unknown as { vyotiq: unknown }).vyotiq = { taskFileDiff }
    const hook = renderHook(() =>
      useTaskChangedLines({ workspacePath: 'C:/ws', runId: 'run-1', path: 'a.ts', changed: true, revision: '0' })
    )
    await waitFor(() => expect(taskFileDiff).toHaveBeenCalled())
    expect(hook.result.current).toBeNull()
  })
})
