/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Textarea } from '@renderer/lib/ui/Textarea'

afterEach(() => {
  cleanup()
})

describe('Textarea', () => {
  it('draws Input’s bordered field chrome, one type size per size', () => {
    render(<Textarea size="sm" aria-label="Notes" />)
    const field = screen.getByRole('textbox', { name: 'Notes' })
    for (const cls of ['border', 'border-border', 'bg-bg', 'rounded-md', 'placeholder:text-tertiary', 'text-xs', 'px-2.5']) {
      expect(field.classList.contains(cls)).toBe(true)
    }
    // `cn()` cannot override: a size must never ride alongside the other one.
    expect(field.classList.contains('text-sm')).toBe(false)
    expect(field.classList.contains('border-none')).toBe(false)
    expect(field.getAttribute('rows')).toBe('3')
  })

  it('defaults to the body size and lets rows set the height', () => {
    render(<Textarea aria-label="Body" rows={5} />)
    const field = screen.getByRole('textbox', { name: 'Body' })
    expect(field.classList.contains('text-sm')).toBe(true)
    expect(field.classList.contains('text-xs')).toBe(false)
    expect(field.getAttribute('rows')).toBe('5')
  })
})
