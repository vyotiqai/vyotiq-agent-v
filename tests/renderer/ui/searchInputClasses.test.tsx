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

/** The field's height lives on its wrapper: `h-8` at md, `h-7` at sm — one of them, never both. */
const WRAPPER_H = ['h-8', 'h-7']

function wrapper(): HTMLElement {
  const el = input().parentElement
  if (!el) throw new Error('SearchInput input has no wrapper')
  return el
}

describe('SearchInput size classes', () => {
  it('the default (md) field: one wrapper height, one text size, no min-h on the input', () => {
    render(<SearchInput aria-label="Search" value="" onChange={vi.fn()} />)
    expect(onlyOneOf(wrapper(), WRAPPER_H)).toBe('h-8')
    expect(onlyOneOf(input(), MIN_H)).toBe(null)
    expect(onlyOneOf(input(), TEXT_SIZE)).toBe('text-sm')
  })

  it('size="sm" is the menu-row field: h-7 and text-xs, one of each', () => {
    render(<SearchInput aria-label="Search" size="sm" value="" onChange={vi.fn()} />)
    expect(onlyOneOf(wrapper(), WRAPPER_H)).toBe('h-7')
    expect(onlyOneOf(input(), MIN_H)).toBe(null)
    expect(onlyOneOf(input(), TEXT_SIZE)).toBe('text-xs')
  })

  it("the menu's search header takes size=\"sm\", not an appended class", async () => {
    render(<SearchableMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Branch/ }))
    await screen.findByRole('option', { name: 'feat/x' })

    // The old call site appended `min-h-7 text-xs` through inputClassName
    // beside the base `min-h-[…] text-sm`; cn() has no tailwind-merge, so the
    // winner was emission order in the sheet. Exactly one of each slot survives.
    expect(onlyOneOf(wrapper(), WRAPPER_H)).toBe('h-7')
    expect(onlyOneOf(input(), MIN_H)).toBe(null)
    expect(onlyOneOf(input(), TEXT_SIZE)).toBe('text-xs')
  })
})
