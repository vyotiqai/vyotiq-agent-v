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

describe('ReviewDiffTable new files', () => {
  const NEW_FILE = '@@ -0,0 +1,2 @@\n+# Notes\n+second\n'
  const INSERT = '@@ -3,0 +4 @@\n+inserted\n'

  it('drops the wash and the old side, keeping the + gutter and one number column', () => {
    const { container } = render(<ReviewDiffTable path="notes.md" diff={NEW_FILE} layout="split" numbers="both" />)
    const table = container.querySelector('table')!
    expect(table.hasAttribute('data-review-new')).toBe(true)
    expect(container.querySelector('.diff-row-add')).toBeNull()
    // Unified: number, sign, code.
    expect(table.querySelectorAll('col')).toHaveLength(3)
    const rows = table.querySelectorAll('[data-diff-line="add"]')
    expect(rows).toHaveLength(2)
    expect([...rows[0]!.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['1', '+', '# Notes'])
  })

  it('keeps the wash on an edit that only adds lines to an existing file', () => {
    const { container } = render(<ReviewDiffTable path="a.ts" diff={INSERT} layout="unified" />)
    expect(container.querySelector('[data-review-new]')).toBeNull()
    expect(container.querySelector('.diff-row-add')).toBeTruthy()
  })

  it('takes the file status when the diff cannot say', () => {
    const { container } = render(<ReviewDiffTable path="a.ts" diff={INSERT} layout="unified" added />)
    expect(container.querySelector('.diff-row-add')).toBeNull()
  })
})
