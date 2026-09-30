/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  registerEditorFlush,
  resetEditorFlushesForTests,
  useEditorFlushResponder
} from '@renderer/lib/hooks/useEditorFlushResponder'

afterEach(() => {
  cleanup()
  resetEditorFlushesForTests()
})

function bridge() {
  let handler: ((requestId: string) => void) | null = null
  const respond = vi.fn()
  // @ts-expect-error test bridge
  window.vyotiq = {
    onWorkspaceEditorFlushRequest: (h: (requestId: string) => void) => {
      handler = h
      return () => {
        handler = null
      }
    },
    respondWorkspaceEditorFlush: respond
  }
  return { ask: (id: string) => handler?.(id), respond, listening: () => handler !== null }
}

describe('editor flush before quit', () => {
  it('answers at once when no view with editors is mounted (Home, Settings…)', async () => {
    const b = bridge()
    renderHook(() => useEditorFlushResponder())
    b.ask('q1')
    await waitFor(() => expect(b.respond).toHaveBeenCalledWith('q1', true))
  })

  it('asks every mounted editor and says false if any could not save, or threw', async () => {
    const b = bridge()
    renderHook(() => useEditorFlushResponder())
    const saved = vi.fn(async () => true)
    const unsaved = registerEditorFlush(async () => false)
    registerEditorFlush(saved)
    b.ask('q2')
    await waitFor(() => expect(b.respond).toHaveBeenCalledWith('q2', false))
    expect(saved).toHaveBeenCalledTimes(1)

    unsaved()
    const throws = registerEditorFlush(async () => {
      throw new Error('disk full')
    })
    b.ask('q3')
    await waitFor(() => expect(b.respond).toHaveBeenCalledWith('q3', false))

    throws()
    b.ask('q4')
    await waitFor(() => expect(b.respond).toHaveBeenCalledWith('q4', true))
  })

  it('stops listening when the app root unmounts', () => {
    const b = bridge()
    const { unmount } = renderHook(() => useEditorFlushResponder())
    expect(b.listening()).toBe(true)
    unmount()
    expect(b.listening()).toBe(false)
  })
})
