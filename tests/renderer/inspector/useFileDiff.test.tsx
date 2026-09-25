/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useFileDiff } from '@renderer/features/inspector/ChangesList'

const DIFF = '@@ -1 +1 @@\n-old\n+new\n'

describe('useFileDiff', () => {
  it('keeps the diff on screen while the same file is fetched again', async () => {
    const first = vi.fn().mockResolvedValue({ content: DIFF })
    const { result, rerender } = renderHook(({ fetchDiff }) => useFileDiff('a.ts', null, fetchDiff), {
      initialProps: { fetchDiff: first }
    })
    await waitFor(() => expect(result.current.state).toBe('text'))

    // A rebuilt source (the workspace changed) fetches again; the table must not
    // unmount in between, or a question half-typed on a line is lost.
    let answer: (value: { content: string }) => void = () => {}
    const again = vi.fn(() => new Promise<{ content: string }>((resolve) => (answer = resolve)))
    rerender({ fetchDiff: again })
    expect(again).toHaveBeenCalledWith('a.ts')
    expect(result.current.state).toBe('text')

    await act(async () => answer({ content: `${DIFF} ` }))
    expect(result.current).toEqual({ state: 'text', content: `${DIFF} ` })
  })

  it('reads as loading when a different file is chosen', async () => {
    const fetchDiff = vi.fn((path: string) =>
      path === 'a.ts' ? Promise.resolve({ content: DIFF }) : new Promise<{ content: string }>(() => {})
    )
    const { result, rerender } = renderHook(({ path }) => useFileDiff(path, null, fetchDiff), {
      initialProps: { path: 'a.ts' }
    })
    await waitFor(() => expect(result.current.state).toBe('text'))
    rerender({ path: 'b.ts' })
    expect(result.current.state).toBe('loading')
  })
})
