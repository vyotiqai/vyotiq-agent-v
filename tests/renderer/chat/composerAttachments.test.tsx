/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useComposerImages } from '@renderer/features/chat/components/composer/useComposerImages'
import { useComposerFiles } from '@renderer/features/chat/components/composer/useComposerFiles'
import {
  getComposerAttachments,
  resetComposerAttachmentStoreForTests
} from '@renderer/lib/hooks/composerAttachmentStore'

afterEach(() => {
  cleanup()
  resetComposerAttachmentStoreForTests()
})

describe('composer attachment persistence', () => {
  it('keeps images in the workspace store across hook remounts', () => {
    const first = renderHook(() => useComposerImages('/ws/a::__draft__'))
    act(() => {
      first.result.current.setImages(['data:image/png;base64,x'])
    })
    expect(first.result.current.images).toHaveLength(1)
    first.unmount()

    // Remount (run-tab switch bumps surfaceKey) — state comes back from the store.
    const second = renderHook(() => useComposerImages('/ws/a::__draft__'))
    expect(second.result.current.images).toEqual(['data:image/png;base64,x'])
  })

  it('scopes attachments per workspace path', () => {
    const a = renderHook(() => useComposerImages('/ws/a::__draft__'))
    act(() => {
      a.result.current.setImages(['img-a'])
    })
    const b = renderHook(() => useComposerImages('/ws/b::__draft__'))
    expect(b.result.current.images).toEqual([])
  })

  it('scopes attachments per run on the same workspace', () => {
    const runA = renderHook(() => useComposerImages('/ws/a::run-1'))
    act(() => {
      runA.result.current.setImages(['img-run-1'])
    })
    const runB = renderHook(() => useComposerImages('/ws/a::run-2'))
    expect(runB.result.current.images).toEqual([])
  })

  it('keeps files and native files across remounts via persistKey', () => {
    const first = renderHook(() => useComposerFiles({ persistKey: '/ws/a::__draft__' }))
    act(() => {
      first.result.current.setFiles([{ type: 'file', name: 'a.md', mime: 'text/markdown', text: 'hi' }])
      first.result.current.setNativeFiles([
        { type: 'file_native', name: 'b.pdf', mime: 'application/pdf', data: 'zz' }
      ])
    })
    first.unmount()

    const second = renderHook(() => useComposerFiles({ persistKey: '/ws/a::__draft__' }))
    expect(second.result.current.files).toHaveLength(1)
    expect(second.result.current.nativeFiles).toHaveLength(1)
    expect(getComposerAttachments('/ws/a::__draft__').files[0]?.name).toBe('a.md')
  })

  it('falls back to local state without a persistKey', () => {
    const hook = renderHook(() => useComposerImages())
    act(() => {
      hook.result.current.setImages(['local'])
    })
    expect(hook.result.current.images).toEqual(['local'])
    expect(getComposerAttachments('/ws/a::__draft__').images).toEqual([])
  })
})
