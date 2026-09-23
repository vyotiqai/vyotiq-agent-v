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
  it('clicking a user prompt calls onBeginEditUserMessage with its message index', () => {
    const onBegin = vi.fn()
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'first prompt' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'ok' },
      { kind: 'message', id: 'user-2', role: 'user', content: 'second prompt' }
    ]

    render(<MessageList items={items} onBeginEditUserMessage={onBegin} />)

    const editable = screen.getAllByLabelText('Edit message')
    expect(editable).toHaveLength(2)
    expect(document.querySelector('[data-prompt-pin]')).toBeNull()
    fireEvent.click(screen.getByText('first prompt'))
    expect(onBegin).toHaveBeenCalledWith(0)
    onBegin.mockClear()
    fireEvent.click(screen.getByText('second prompt'))
    expect(onBegin).toHaveBeenCalledWith(2)
    onBegin.mockClear()
    fireEvent.keyDown(screen.getAllByRole('button', { name: 'Edit user message' })[0]!, {
      key: 'Enter'
    })
    expect(onBegin).toHaveBeenCalledWith(0)
  })

  it('shows revert-to-prompt control only when later transcript content exists', () => {
    const onRevert = vi.fn()
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'first prompt' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'ok' },
      { kind: 'message', id: 'user-2', role: 'user', content: 'second prompt' },
      { kind: 'message', id: 'a2', role: 'assistant', content: 'ok2' }
    ]

    const { rerender } = render(
      <MessageList
        items={items}
        messageCount={4}
        onRevertUserMessage={onRevert}
      />
    )

    expect(screen.getAllByLabelText('Revert to before this prompt')).toHaveLength(2)

    rerender(
      <MessageList
        items={[{ kind: 'message', id: 'user-0', role: 'user', content: 'solo prompt' }]}
        messageCount={1}
        onRevertUserMessage={onRevert}
      />
    )
    expect(screen.queryByLabelText('Revert to before this prompt')).toBeNull()

    rerender(
      <MessageList
        items={items}
        messageCount={4}
        running
        onRevertUserMessage={onRevert}
      />
    )
    expect(screen.queryByLabelText('Revert to before this prompt')).toBeNull()
  })

  it('clicking revert calls onRevertUserMessage with its message index', () => {
    const onRevert = vi.fn()
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'first prompt' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'ok' }
    ]

    render(
      <MessageList items={items} messageCount={2} onRevertUserMessage={onRevert} />
    )

    fireEvent.click(screen.getByLabelText('Revert to before this prompt'))
    expect(onRevert).toHaveBeenCalledWith(0)
  })

  it('replaces the user bubble with editComposer while editing', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'original prompt' }
    ]

    render(
      <MessageList
        items={items}
        editingUserMessageIndex={0}
        editComposer={<div data-testid="inline-composer">editing…</div>}
        onBeginEditUserMessage={() => {}}
      />
    )

    expect(screen.getByTestId('inline-composer')).toBeTruthy()
    expect(screen.queryByText('original prompt')).toBeNull()
    expect(screen.queryByLabelText('Edit message')).toBeNull()
  })

  it('groups editable user prompts so the actions reveal on hover', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'hover me' }
    ]

    render(<MessageList items={items} onBeginEditUserMessage={() => {}} />)

    const editBtn = screen.getByLabelText('Edit message')
    const bubble = editBtn.closest('[aria-label="Edit user message"]')
    expect(bubble).toBeTruthy()
    expect(bubble?.className).toContain('group/prompt')
  })

  it('releases the sticky pin while a prompt is being edited', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'original prompt' },
      { kind: 'message', id: 'a0', role: 'assistant', content: 'reply' }
    ]

    const { rerender } = render(
      <MessageList items={items} onBeginEditUserMessage={() => {}} />
    )
    expect(document.querySelector('[data-sticky-turn-prompt]')!.className).toContain('sticky')

    rerender(
      <MessageList
        items={items}
        editingUserMessageIndex={0}
        editComposer={<div data-testid="inline-composer">editing…</div>}
        onBeginEditUserMessage={() => {}}
      />
    )

    // Left pinned, the edit composer sticks to the top of the transcript for as
    // long as you are typing. The row keeps its spacing, just not the pin.
    const wrapper = document.querySelector('[data-sticky-turn-prompt]')!
    expect(wrapper.className).not.toContain('sticky')
    expect(wrapper.className).not.toContain('vy-turn-prompt-cover')
    expect(wrapper.className).toContain('pt-2.5')
    expect(wrapper.className).toContain('pb-4')
    expect(screen.getByTestId('inline-composer')).toBeTruthy()
  })
})
