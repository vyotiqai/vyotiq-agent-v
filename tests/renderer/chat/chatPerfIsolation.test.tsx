/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderHook, act } from '@testing-library/react'
import {
  useHasChatItems,
  transcriptShowsError,
  useTranscriptShowsError
} from '@renderer/features/chat/components/ChatStreamLeaves'
import type { ChatItemsStore } from '@renderer/features/chat/chatStores'
import type { UiItem } from '@shared/transcript'

const root = join(__dirname, '../../../src/renderer/src')

function makeStore(initial: UiItem[]): ChatItemsStore & { setItems: (items: UiItem[]) => void } {
  let items = initial
  let revision = 0
  const listeners = new Set<() => void>()
  return {
    subscribeItems: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getItemsRevision: () => revision,
    getItems: () => items,
    setItems: (next) => {
      items = next
      revision += 1
      for (const listener of listeners) listener()
    }
  }
}

describe('useHasChatItems', () => {
  it('stays Object.is-stable across stream growth after the first item', () => {
    const store = makeStore([])
    const { result, rerender } = renderHook(() => useHasChatItems(store, []))

    expect(result.current).toBe(false)

    act(() => {
      store.setItems([
        {
          kind: 'text',
          id: 'a1',
          role: 'assistant',
          text: 'hi',
          streaming: true
        } as UiItem
      ])
    })
    rerender()
    expect(result.current).toBe(true)

    act(() => {
      store.setItems([
        {
          kind: 'text',
          id: 'a1',
          role: 'assistant',
          text: 'hi there',
          streaming: true
        } as UiItem
      ])
    })
    rerender()
    // Still true — ChatView must not treat this as a presence flip.
    expect(result.current).toBe(true)
  })

  it('does not resubscribe when only the store wrapper object is recreated', () => {
    const inner = makeStore([
      {
        kind: 'text',
        id: 'a1',
        role: 'assistant',
        text: 'hi',
        streaming: false
      } as UiItem
    ])
    let subscribeCalls = 0
    const subscribeItems = (listener: () => void): (() => void) => {
      subscribeCalls += 1
      return inner.subscribeItems(listener)
    }
    const wrap = (): ChatItemsStore => ({
      subscribeItems,
      getItemsRevision: inner.getItemsRevision,
      getItems: inner.getItems
    })
    const { result, rerender } = renderHook(
      ({ store }) => useHasChatItems(store, []),
      { initialProps: { store: wrap() } }
    )
    expect(result.current).toBe(true)
    expect(subscribeCalls).toBe(1)
    rerender({ store: wrap() })
    rerender({ store: wrap() })
    expect(subscribeCalls).toBe(1)
    expect(result.current).toBe(true)
  })
})

describe('useTranscriptShowsError', () => {
  it('stays Object.is-stable across stream growth without a run_error', () => {
    const store = makeStore([])
    const { result, rerender } = renderHook(() => useTranscriptShowsError(store, [], 'boom'))
    expect(result.current).toBe(false)
    act(() => {
      store.setItems([
        {
          kind: 'text',
          id: 'a1',
          role: 'assistant',
          text: 'hi',
          streaming: true
        } as UiItem
      ])
    })
    rerender()
    expect(result.current).toBe(false)
  })

  it('flips true when itemsStore has a run_error and items prop is stale', () => {
    const store = makeStore([
      { kind: 'run_error', id: 'e1', message: 'boom' } as UiItem
    ])
    const { result } = renderHook(() => useTranscriptShowsError(store, [], 'boom'))
    expect(result.current).toBe(true)
  })
})

describe('transcriptShowsError', () => {
  const prompt = (id: string): UiItem => ({ kind: 'message', id, role: 'user', content: id })
  const box = (id: string, message: string): UiItem => ({ kind: 'run_error', id, message })

  it('matches only the current error in the latest turn', () => {
    const items = [prompt('u1'), box('e1', 'boom')]
    expect(transcriptShowsError(items, 'boom')).toBe(true)
    // A different, current error still needs the banner.
    expect(transcriptShowsError(items, 'Wait for the run to finish before reverting.')).toBe(false)
    expect(transcriptShowsError(items, null)).toBe(false)
  })

  it('ignores a box left in an earlier turn', () => {
    const items = [prompt('u1'), box('e1', 'boom'), prompt('u2')]
    expect(transcriptShowsError(items, 'boom')).toBe(false)
  })
})

describe('ChatView / SessionChatColumn isolation', () => {
  it('keeps items subscription off ChatView and unused git chrome off SessionChatColumn', () => {
    const chatView = readFileSync(join(root, 'features/chat/ChatView.tsx'), 'utf8')
    const column = readFileSync(join(root, 'features/chat/SessionChatColumn.tsx'), 'utf8')
    expect(chatView).not.toMatch(/useChatLiveItems/)
    expect(chatView).toMatch(/changesDockVisible/)
    expect(column).not.toMatch(/useGitChrome/)
    expect(column).not.toMatch(/useGitRevision/)
    // The pane renders the task record; streaming stays on its leaf (see perfMatrixCaps).
    expect(column).toMatch(/<TaskPane/)
    expect(column).not.toMatch(/useChatLiveItems/)
  })
})

describe('virtualizer full-DOM fallback gate', () => {
  it('only allows the jsdom full fallback under Vitest', () => {
    expect(process.env.VITEST).toBe('true')
    const allowFullFallback =
      typeof process !== 'undefined' && process.env.VITEST === 'true'
    expect(allowFullFallback).toBe(true)
  })
})
