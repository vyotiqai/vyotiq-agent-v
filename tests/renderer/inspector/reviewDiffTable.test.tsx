/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ReviewDiffTable } from '@renderer/features/inspector/ReviewDiffTable'

const DIFF = '@@ -1 +1 @@\n-old line\n+new line\n'
const ask = { name: 'Ask the agent about line 1' }

describe('ReviewDiffTable questions', () => {
  it('keeps a question open across a re-render with the same diff, and closes it for another file', () => {
    const onAsk = vi.fn()
    const { rerender } = render(<ReviewDiffTable path="a.ts" diff={DIFF} layout="unified" onAsk={onAsk} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about line 1' }))
    expect(screen.getByRole('textbox', ask)).toBeTruthy()

    // A refetch that returns the same text is not a change.
    rerender(<ReviewDiffTable path="a.ts" diff={`${DIFF}`} layout="unified" onAsk={onAsk} />)
    expect(screen.getByRole('textbox', ask)).toBeTruthy()

    rerender(<ReviewDiffTable path="b.ts" diff={DIFF} layout="unified" onAsk={onAsk} />)
    expect(screen.queryByRole('textbox', ask)).toBeNull()
  })

  it('closes the question when the diff itself changes', () => {
    const { rerender } = render(<ReviewDiffTable path="a.ts" diff={DIFF} layout="unified" onAsk={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about line 1' }))
    rerender(<ReviewDiffTable path="a.ts" diff={'@@ -1 +1 @@\n-old line\n+newer line\n'} layout="unified" onAsk={vi.fn()} />)
    expect(screen.queryByRole('textbox', ask)).toBeNull()
  })
})
