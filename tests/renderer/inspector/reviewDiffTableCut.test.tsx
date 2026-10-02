/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ReviewDiffTable } from '@renderer/features/inspector/ReviewDiffTable'
import { REVIEW_MAX_LINES } from '@renderer/features/inspector/reviewDiff'
import { linesLeftOut } from '@renderer/features/chat/components/linesLeftOut'

afterEach(() => cleanup())

/** A hunk of `n` added lines, then `ctx` lines of context and `tail` more changes past the cap. */
function longDiff(after: string[]): string {
  const head = Array.from({ length: REVIEW_MAX_LINES }, (_, i) => `+line ${i + 1}`)
  return ['@@ -0,0 +1,2000 @@', ...head, ...after, ''].join('\n')
}

const note = (container: HTMLElement): string | null | undefined =>
  container.querySelector('[data-review-cut]')?.textContent

describe('ReviewDiffTable cut', () => {
  it('counts the changed lines past the cut, not the context', () => {
    const after = [' same', ' same', '-gone', '+came', '+came too', ' same']
    const { container } = render(<ReviewDiffTable path="a.ts" diff={longDiff(after)} layout="unified" />)
    expect(note(container)).toBe('3 more changed lines')
  })

  it('says one line in the singular', () => {
    const { container } = render(<ReviewDiffTable path="a.ts" diff={longDiff(['+one more'])} layout="unified" />)
    expect(note(container)).toBe('1 more changed line')
  })

  it('keeps the plain note when only context is past the cut', () => {
    const { container } = render(<ReviewDiffTable path="a.ts" diff={longDiff([' same', ' same'])} layout="split" />)
    expect(note(container)).toBe(`Only the first ${REVIEW_MAX_LINES} lines are shown.`)
  })

  it('says nothing when nothing was cut', () => {
    const { container } = render(<ReviewDiffTable path="a.ts" diff={'@@ -1 +1 @@\n-old\n+new\n'} layout="unified" />)
    expect(container.querySelector('[data-review-cut]')).toBeNull()
  })
})

describe('linesLeftOut', () => {
  it('words a cut the same way for diffs and output', () => {
    expect(linesLeftOut(2, 'more', 'changed')).toBe('2 more changed lines')
    expect(linesLeftOut(1, 'earlier', 'changed')).toBe('1 earlier changed line')
    expect(linesLeftOut(14, 'earlier')).toBe('14 earlier lines')
  })
})
