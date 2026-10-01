/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Segmented } from '@renderer/lib/ui'

afterEach(cleanup)

const ITEMS = [
  { id: 'a', label: 'Fit' },
  { id: 'b', label: '390' }
] as const

const heights = (el: Element): string[] => [...el.classList].filter((c) => /^h-\d+$/.test(c))

describe('Segmented sizes', () => {
  it('sits in a 40px row at xs: a 24px track, 20px segments that hit at 24px', () => {
    render(<Segmented label="Viewport" value="a" items={ITEMS} size="xs" />)
    const group = screen.getByRole('radiogroup', { name: 'Viewport' })
    // cn() has no tailwind-merge: exactly one height on each, never two.
    expect(heights(group)).toEqual(['h-6'])
    const fit = screen.getByRole('radio', { name: 'Fit' })
    expect(heights(fit)).toEqual(['h-5'])
    expect(fit.classList.contains('before:-inset-y-0.5')).toBe(true)
  })

  it('keeps its 28px track by default', () => {
    render(<Segmented label="Viewport" value="a" items={ITEMS} />)
    expect(heights(screen.getByRole('radiogroup', { name: 'Viewport' }))).toEqual(['h-7'])
    expect(heights(screen.getByRole('radio', { name: 'Fit' }))).toEqual(['h-6'])
  })
})
