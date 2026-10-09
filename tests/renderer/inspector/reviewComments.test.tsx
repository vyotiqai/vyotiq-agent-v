/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReviewCommentsContext, ReviewDiffTable, askLineKey, type AskTarget } from '@renderer/features/inspector/ReviewDiffTable'
import { reviewInstruction, reviewLineLabel } from '@renderer/features/inspector/reviewComments'

afterEach(cleanup)

const DIFF = '@@ -1,3 +1,3 @@\n context a\n-old b\n+new b\n context c\n'

describe('review comments', () => {
  it('adds a comment to the review with Ctrl+Enter, and Enter still sends at once', () => {
    const onAsk = vi.fn()
    const onQueue = vi.fn()
    render(
      <ReviewCommentsContext.Provider value={{ onQueue }}>
        <ReviewDiffTable path="a.ts" diff={DIFF} layout="unified" onAsk={onAsk} />
      </ReviewCommentsContext.Provider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ask about line 2' }))
    const box = screen.getByRole('textbox', { name: 'Ask the agent about line 2' })
    fireEvent.change(box, { target: { value: 'Name this better' } })
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    expect(onQueue).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts', side: 'new' }), 'Name this better')
    expect(onAsk).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Ask about line 3' }))
    const again = screen.getByRole('textbox', { name: 'Ask the agent about line 3' })
    fireEvent.change(again, { target: { value: 'Why?' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts' }), 'Why?')
  })

  it('covers a range with Shift+click on a second line', () => {
    const onQueue = vi.fn()
    render(
      <ReviewCommentsContext.Provider value={{ onQueue }}>
        <ReviewDiffTable path="a.ts" diff={DIFF} layout="unified" onAsk={vi.fn()} />
      </ReviewCommentsContext.Provider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ask about line 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask about line 3' }), { shiftKey: true })
    const box = screen.getByRole('textbox', { name: 'Ask the agent about lines 1 to 3' })
    fireEvent.change(box, { target: { value: 'Collapse these' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to review' }))
    const target = onQueue.mock.calls[0]![0] as AskTarget
    expect(target.lines?.map((l) => l.text)).toEqual(['context a', 'new b', 'context c'])
    expect(reviewLineLabel(target)).toBe('1–3')
  })

  it('marks a line that has a comment waiting', () => {
    const line = { kind: 'add' as const, text: 'new b', oldN: null, newN: 2, i: 2 }
    render(
      <ReviewCommentsContext.Provider value={{ onQueue: vi.fn(), queuedLines: new Set([askLineKey('a.ts', 'new', line)]) }}>
        <ReviewDiffTable path="a.ts" diff={DIFF} layout="unified" onAsk={vi.fn()} />
      </ReviewCommentsContext.Provider>
    )
    expect(screen.getByRole('button', { name: 'Ask about line 2 (has a review comment)' }).className).toContain('text-accent')
  })

  it('sends a review as one numbered instruction', () => {
    const at = (n: number, text: string) => ({ path: 'a.ts', side: 'new' as const, line: { kind: 'ctx' as const, text, oldN: n, newN: n, i: n } })
    const text = reviewInstruction([
      { id: '1', target: at(1, 'context a'), comment: 'Rename' },
      { id: '2', target: { ...at(3, 'context c'), path: 'b.ts' }, comment: 'Add a test' }
    ])
    expect(text.startsWith('Review comments on your changes — address each one:')).toBe(true)
    expect(text).toContain('### 1. In `a.ts`, line 1:\n```\ncontext a\n```\n\nRename')
    expect(text).toContain('### 2. In `b.ts`, line 3:')
  })
})
