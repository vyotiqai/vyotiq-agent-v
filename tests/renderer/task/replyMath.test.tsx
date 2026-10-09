/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { ReplyMarkdown } from '@renderer/features/task/record/reply/ReplyMarkdown'
import { normalizeMathDelimiters } from '@renderer/features/task/record/reply/math'

afterEach(cleanup)

describe('math delimiters other models write', () => {
  it('turns \\(…\\) and \\[…\\] into remark-math’s, outside code', () => {
    expect(normalizeMathDelimiters('Area is \\(\\pi r^2\\) here.')).toBe('Area is $$\\pi r^2$$ here.')
    expect(normalizeMathDelimiters('\\[\nE = mc^2\n\\]')).toBe('$$\nE = mc^2\n$$')
    expect(normalizeMathDelimiters('\\[ a + b \\]')).toBe('$$\na + b\n$$')
    expect(normalizeMathDelimiters('Keep `\\(x\\)` as code.')).toBe('Keep `\\(x\\)` as code.')
    expect(normalizeMathDelimiters('```\n\\(x\\)\n```')).toBe('```\n\\(x\\)\n```')
  })
})

describe('math in a reply', () => {
  it('renders $$…$$ inline and as a block, and ```math, with KaTeX', async () => {
    const { container } = render(
      <ReplyMarkdown text={'The sum $$a^2 + b^2$$ holds.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n```math\nx = 1\n```'} />
    )
    await waitFor(() => expect(container.querySelectorAll('.katex').length).toBe(3))
    expect(container.querySelectorAll('[data-math="inline"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-math="display"]')).toHaveLength(2)
  })

  it('leaves prices and shell variables alone', () => {
    const { container } = render(<ReplyMarkdown text={'It cost $5 and then $10; set $HOME first.'} />)
    expect(container.textContent).toContain('It cost $5 and then $10; set $HOME first.')
    expect(container.querySelector('[data-math]')).toBeNull()
  })
})
