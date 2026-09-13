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
      workspaceSuggestPaths: vi.fn().mockResolvedValue({ ok: true, data: { paths: [], total: 0 } }),
      listRuns: vi.fn().mockResolvedValue({ ok: true, data: { runs: [] } }),
      gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'not_repo' } })
    }
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
