/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerMentions } from '@renderer/features/chat/components/composer/useComposerMentions'

beforeEach(() => {
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      workspaceSuggestPaths: vi.fn().mockResolvedValue({ ok: true, data: { paths: [], dirs: [], total: 0 } }),
      listRuns: vi.fn().mockResolvedValue({ ok: true, data: { runs: [] } }),
      gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'not_repo' } })
    }
  })
})

describe('useComposerMentions bare @ rows', () => {
  it('runs a search for an empty query and lists the rows it returns', async () => {
    ;(window.vyotiq.workspaceSuggestPaths as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true as const,
      // Main's shape: files and directories ranked as two lists.
      data: { paths: ['src/components/composer/a.ts'], dirs: ['src/components'], total: 1 }
    })

    const { result } = renderHook(() =>
      useComposerMentions({
        workspacePath: '/tmp/ws',
        text: '@',
        cursor: 1,
        enabled: true
      })
    )

    await vi.waitFor(() =>
      expect(window.vyotiq.workspaceSuggestPaths).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/tmp/ws', query: '' })
      )
    )
    await vi.waitFor(() =>
      expect(
        result.current.items.filter((i) => i.kind === 'file' || i.kind === 'folder')
      ).toHaveLength(2)
    )
    // The directory in the result set is a folder row, not a file row.
    expect(result.current.items.find((i) => i.kind === 'folder')).toMatchObject({
      id: 'folder:src/components',
      path: 'src/components'
    })
    expect(result.current.error).toBeNull()
  })

  it('lists a folder main matched even when no file under it made the page', async () => {
    // The hook used to read only `paths` and guess folders from them, so a
    // folder was a row only when one of its own files happened to match too.
    ;(window.vyotiq.workspaceSuggestPaths as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true as const,
      data: { paths: ['README.md', 'src/main.ts'], dirs: ['src/composer'], total: 2 }
    })

    const { result } = renderHook(() =>
      useComposerMentions({
        workspacePath: '/tmp/ws',
        text: '@comp',
        cursor: 5,
        enabled: true
      })
    )

    // Typed as the folder's own name, it leads rather than trailing the files.
    await vi.waitFor(() =>
      expect(result.current.items.find((i) => i.kind === 'folder' || i.kind === 'file')).toMatchObject(
        { kind: 'folder', id: 'folder:src/composer', path: 'src/composer' }
      )
    )
  })
})

describe('useComposerMentions suggest failure', () => {
  it('surfaces a failed suggest instead of reporting no matches', async () => {
    ;(window.vyotiq.workspaceSuggestPaths as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false as const,
      error: 'Workspace is not open'
    })

    const { result } = renderHook(() =>
      useComposerMentions({
        workspacePath: '/tmp/ws',
        text: '@ma',
        cursor: 3,
        enabled: true
      })
    )

    await vi.waitFor(() => expect(result.current.error).toBe('Workspace is not open'))
    expect(result.current.items.some((i) => i.kind === 'file')).toBe(false)
  })

  it('surfaces a rejected suggest and clears it on the next success', async () => {
    ;(window.vyotiq.workspaceSuggestPaths as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('IPC channel closed'))
      .mockResolvedValue({ ok: true as const, data: { paths: ['src/main.ts'], dirs: [], total: 1 } })

    const { result, rerender } = renderHook(
      ({ text, cursor }: { text: string; cursor: number }) =>
        useComposerMentions({
          workspacePath: '/tmp/ws',
          text,
          cursor,
          enabled: true
        }),
      { initialProps: { text: '@ma', cursor: 3 } }
    )

    await vi.waitFor(() => expect(result.current.error).toBe('IPC channel closed'))

    rerender({ text: '@mai', cursor: 4 })
    await vi.waitFor(() => expect(result.current.error).toBeNull())
    expect(result.current.items.some((i) => i.kind === 'file')).toBe(true)
  })
})

describe('useComposerMentions open behavior', () => {
  it('stays open with an @ token even when nothing matches', async () => {
    const { result } = renderHook(() =>
      useComposerMentions({
        workspacePath: '/tmp/ws',
        text: '@zzzzunlikely',
        cursor: 13,
        enabled: true
      })
    )

    await act(async () => {
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(result.current.open).toBe(true))
    expect(result.current.token).not.toBeNull()
  })

  it('closes after dismiss while the token remains', async () => {
    const { result } = renderHook(() =>
      useComposerMentions({
        workspacePath: '/tmp/ws',
        text: '@',
        cursor: 1,
        enabled: true
      })
    )

    await act(async () => {
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(result.current.open).toBe(true))

    act(() => result.current.dismiss())
    expect(result.current.open).toBe(false)
  })
})
