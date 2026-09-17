/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import {
  estimateTranscriptRowSize,
  MessageList,
  transcriptRowsContentRevision
} from '@renderer/features/chat/components/MessageList'
import { buildTranscriptRows } from '@renderer/features/chat/utils/transcriptRows'
import {
  TOOL_BODY_CLAMP_PX,
  TOOL_GROUP_LIST_ESTIMATE_MIN_PX,
  TOOL_TERMINAL_VIEWPORT_MAX_PX
} from '@renderer/lib/utils/layout'
import type { UiItem } from '@shared/transcript'
import { toolGroup } from './helpers/testGroups'
import { emptyStepUsageTotals } from '@shared/utils/runTelemetry'

function visibleTextMatches(pattern: RegExp): HTMLElement[] {
  return screen
    .getAllByText(pattern)
    .filter((element) => !element.closest('[data-live-receipt-announcement]'))
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
})

describe('MessageList', () => {
  it('jumps to the latest messages on End', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'A reply from the assistant' }
    ]
    render(<MessageList items={items} />)
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    const scrollTopSet = vi.fn()
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => 200,
      set: scrollTopSet
    })
    Object.defineProperty(scroll, 'scrollTo', {
      configurable: true,
      value: ({ top }: { top: number }) => {
        scrollTopSet(top)
      }
    })

    fireEvent.keyDown(window, { key: 'End' })
    expect(scrollTopSet).toHaveBeenCalledWith(4000)
  })

  it('jumps to the top on Home', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'A reply from the assistant' }
    ]
    render(<MessageList items={items} />)
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    const scrollTopSet = vi.fn()
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => 200,
      set: scrollTopSet
    })
    Object.defineProperty(scroll, 'scrollTo', {
      configurable: true,
      value: ({ top }: { top: number }) => {
        scrollTopSet(top)
      }
    })

    fireEvent.keyDown(window, { key: 'Home' })
    expect(scrollTopSet).toHaveBeenCalledWith(0)
  })

  it('does not jump on End from a text field', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' }
    ]
    render(
      <>
        <input aria-label="Other field" />
        <MessageList items={items} />
      </>
    )
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    const scrollTopSet = vi.fn()
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => 200,
      set: scrollTopSet
    })
    Object.defineProperty(scroll, 'scrollTo', {
      configurable: true,
      value: ({ top }: { top: number }) => {
        scrollTopSet(top)
      }
    })
    fireEvent.keyDown(screen.getByLabelText('Other field'), { key: 'End' })
    expect(scrollTopSet).not.toHaveBeenCalled()
  })

  it('does not jump on Home from a text field', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' }
    ]
    render(
      <>
        <input aria-label="Other field" />
        <MessageList items={items} />
      </>
    )
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    const scrollTopSet = vi.fn()
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => 200,
      set: scrollTopSet
    })
    Object.defineProperty(scroll, 'scrollTo', {
      configurable: true,
      value: ({ top }: { top: number }) => {
        scrollTopSet(top)
      }
    })
    fireEvent.keyDown(screen.getByLabelText('Other field'), { key: 'Home' })
    expect(scrollTopSet).not.toHaveBeenCalled()
  })

  it('opens transcript find with Ctrl+F, counts matches, and closes on Esc', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'A reply about JWT tokens' },
      { kind: 'message', id: 'a2', role: 'assistant', content: 'JWT refresh still pending' }
    ]
    render(<MessageList items={items} />)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const find = screen.getByRole('searchbox', { name: 'Find in transcript' })
    fireEvent.change(find, { target: { value: 'jwt' } })
    expect(screen.getByText('1 of 2')).toBeTruthy()
    fireEvent.keyDown(find, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('2 of 2')).toBeTruthy()
    fireEvent.keyDown(find, { key: 'Enter' })
    expect(screen.getByText('1 of 2')).toBeTruthy()
    fireEvent.keyDown(find, { key: 'Enter' })
    expect(screen.getByText('2 of 2')).toBeTruthy()
    fireEvent.keyDown(find, { key: 'Escape' })
    expect(screen.queryByRole('searchbox', { name: 'Find in transcript' })).toBeNull()
  })

  it('opens transcript find from the composer and ignores other inputs', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' }
    ]
    render(
      <>
        <input aria-label="Other field" />
        <div role="textbox" aria-label="Message" contentEditable tabIndex={0} />
        <MessageList items={items} />
      </>
    )
    fireEvent.keyDown(screen.getByLabelText('Other field'), { key: 'f', ctrlKey: true })
    expect(screen.queryByRole('searchbox', { name: 'Find in transcript' })).toBeNull()

    fireEvent.keyDown(screen.getByRole('textbox', { name: /^message$/i }), {
      key: 'f',
      ctrlKey: true
    })
    expect(screen.getByRole('searchbox', { name: 'Find in transcript' })).toBeTruthy()
  })

  it('counts new messages on the Latest chip while unpinned', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'A reply from the assistant' }
    ]
    const { rerender } = render(<MessageList items={items} />)
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(scroll, 'scrollTop', { configurable: true, value: 200 })
    fireEvent.scroll(scroll)
    expect(screen.getByRole('button', { name: 'Jump to latest messages' })).toBeTruthy()

    rerender(
      <MessageList
        items={[
          ...items,
          {
            kind: 'message',
            id: 'a2',
            role: 'assistant',
            content: 'A later reply from the assistant'
          }
        ]}
      />
    )
    const pill = screen.getByRole('button', { name: 'Jump to latest messages, 1 new' })
    expect(pill.textContent).toContain('Latest')
    expect(pill.textContent).toContain('1')
  })
})
