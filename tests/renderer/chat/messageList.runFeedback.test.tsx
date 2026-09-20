/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MessageList } from '@renderer/features/chat/components/MessageList'
import type { MessageRunFeedback } from '@renderer/features/chat/components/MessageList'
import type { TurnOutcome, UiItem } from '@shared/transcript'

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

const runFeedback: MessageRunFeedback = { value: null, onRate: vi.fn() }

/** Two complete turns, so "latest turn only" is a real distinction. */
function twoTurns(): UiItem[] {
  return [
    { kind: 'message', id: 'u1', role: 'user', content: 'first ask' },
    { kind: 'message', id: 'a1', role: 'assistant', content: 'first answer' },
    { kind: 'message', id: 'u2', role: 'user', content: 'second ask' },
    { kind: 'message', id: 'a2', role: 'assistant', content: 'second answer' }
  ]
}

function renderList(over: {
  turnStatus?: TurnOutcome | null
  running?: boolean
  runFeedback?: MessageRunFeedback
}): void {
  render(
    <MessageList
      items={twoTurns()}
      running={over.running ?? false}
      turnStatus={over.turnStatus ?? null}
      runFeedback={'runFeedback' in over ? over.runFeedback : runFeedback}
    />
  )
}

function thumbs(): HTMLElement[] {
  return [
    ...screen.queryAllByLabelText(/^Mark helpful$/),
    ...screen.queryAllByLabelText(/^Mark unhelpful$/)
  ]
}

describe('MessageList run feedback gate', () => {
  it('offers exactly one control, on the closing answer of a finished run', () => {
    renderList({ turnStatus: 'done' })

    // One pair of thumbs for the whole transcript, not one per turn.
    expect(thumbs()).toHaveLength(2)
  })

  it('offers the control on a failed run — the most useful thing to mark', () => {
    renderList({ turnStatus: 'error' })

    expect(thumbs()).toHaveLength(2)
  })

  it('offers nothing while the run is still going', () => {
    renderList({ turnStatus: null, running: true })

    expect(thumbs()).toHaveLength(0)
  })

  it('offers nothing for a cancelled run', () => {
    // Stopping work is not a verdict on it, and teardown writes no store entry
    // for a cancel — so a rating here would have nothing to merge into.
    renderList({ turnStatus: 'cancelled' })

    expect(thumbs()).toHaveLength(0)
  })

  it('offers nothing when the caller supplies no feedback channel', () => {
    renderList({ turnStatus: 'done', runFeedback: undefined })

    expect(thumbs()).toHaveLength(0)
  })
})
