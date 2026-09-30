/**
 * @vitest-environment jsdom
 */
import { useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SearchInput } from '@renderer/lib/ui/SearchInput'
import { Menu } from '@renderer/lib/ui'
import { resetFloatingLayersForTests } from '@renderer/lib/hooks/floatingLayers'

afterEach(() => {
  cleanup()
  resetFloatingLayersForTests()
})

/** Every class in one sizing slot: at most one of these may ever be on the input. */
const MIN_H = ['min-h-7', 'min-h-[var(--vy-control-min-h)]', 'min-h-[calc(var(--vy-control-min-h)+0.25rem)]']
const TEXT_SIZE = ['text-xs', 'text-sm']

function input(): HTMLInputElement {
  const el = document.querySelector('input[data-vy-text-entry]')
  if (!el) throw new Error('SearchInput rendered no input')
  return el as HTMLInputElement
}

/**
 * classList, not the className string: the competing `min-h-*` classes differ
 * only by bracket text, so only whole-token matching can say which size is on —
 * and a hit count above one is the failure, not a wrong winner.
 */
function onlyOneOf(el: Element, candidates: readonly string[]): string | null {
  const present = candidates.filter((token) => el.classList.contains(token))
  if (present.length > 1) throw new Error(`two competing classes are on the input: ${present.join(' ')}`)
  return present[0] ?? null
}

function SearchableMenu(): JSX.Element {
  const [value, setValue] = useState('a')
  return (
    <Menu
      aria-label="Branch"
      searchable
      value={value}
      onChange={setValue}
      placement="down"
      options={[
        { value: 'a', label: 'main' },
        { value: 'b', label: 'feat/x' }
      ]}
    />
  )
}

describe('SearchInput size classes', () => {
  it('the default field carries one min-h and one text size', () => {
    render(<SearchInput aria-label="Search" value="" onChange={vi.fn()} />)
    const field = input()
    expect(onlyOneOf(field, MIN_H)).toBe('min-h-[var(--vy-control-min-h)]')
    expect(onlyOneOf(field, TEXT_SIZE)).toBe('text-sm')
  })

  it('the quiet default field carries one min-h and one text size', () => {
    render(<SearchInput aria-label="Search" tone="quiet" value="" onChange={vi.fn()} />)
    const field = input()
    expect(onlyOneOf(field, MIN_H)).toBe('min-h-[calc(var(--vy-control-min-h)+0.25rem)]')
    expect(onlyOneOf(field, TEXT_SIZE)).toBe('text-sm')
  })

  it('size="sm" drops the min-h slot rather than competing with it', () => {
    render(<SearchInput aria-label="Search" size="sm" value="" onChange={vi.fn()} />)
    const field = input()
    expect(onlyOneOf(field, MIN_H)).toBe(null)
    expect(onlyOneOf(field, TEXT_SIZE)).toBe('text-xs')
  })

  it('the compact field is a menu row: one min-h-7, one text-xs, no base size beside it', () => {
    render(<SearchInput aria-label="Search" compact value="" onChange={vi.fn()} />)
    const field = input()
    expect(onlyOneOf(field, MIN_H)).toBe('min-h-7')
    expect(onlyOneOf(field, TEXT_SIZE)).toBe('text-xs')
  })

  it("the menu's search header takes the compact state, not an appended class", async () => {
    render(<SearchableMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Branch/ }))
    await screen.findByRole('option', { name: 'feat/x' })

    // The old call site appended `min-h-7 text-xs` through inputClassName
    // beside the base `min-h-[…] text-sm`; cn() has no tailwind-merge, so the
    // winner was emission order in the sheet. Exactly one of each slot survives.
    const field = input()
    expect(onlyOneOf(field, MIN_H)).toBe('min-h-7')
    expect(onlyOneOf(field, TEXT_SIZE)).toBe('text-xs')
  })
})
