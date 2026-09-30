/**
 * @vitest-environment jsdom
 */
import { useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ActionMenu, type ActionMenuItem } from '@renderer/lib/ui/ActionMenu'
import { MENU_ROW, MENU_ROW_ACTIVE, MENU_ROW_IDLE } from '@renderer/lib/ui/menuStyles'

afterEach(() => {
  cleanup()
})

const tokens = (classes: string): string[] => classes.split(/\s+/).filter(Boolean)

function Fixture(): JSX.Element {
  const [open, setOpen] = useState(false)
  const items: ActionMenuItem[] = [
    { id: 'one', label: 'One', onSelect: vi.fn() },
    { id: 'two', label: 'Two', onSelect: vi.fn() }
  ]
  return (
    <ActionMenu
      aria-label="Row focus"
      open={open}
      onOpenChange={setOpen}
      placement="down"
      items={items}
      trigger={(props) => (
        <button
          ref={props.ref}
          type="button"
          aria-expanded={props['aria-expanded']}
          aria-controls={props['aria-controls']}
          aria-haspopup="menu"
          onClick={props.onClick}
        >
          Row focus
        </button>
      )}
    />
  )
}

describe('menu row focus ring', () => {
  it('carries the focus ring, not a focus-visible outline kill', () => {
    // classList, not the className string: `focus-visible:vy-focus-ring` and
    // `focus-visible:outline-none` are both whole tokens, and only whole-token
    // matching can say which one is on the row.
    expect(MENU_ROW.split(/\s+/).filter(Boolean)).toContain('focus-visible:vy-focus-ring')
    for (const token of tokens(MENU_ROW)) {
      expect(token).not.toBe('focus-visible:outline-none')
      expect(token).not.toBe('outline-none')
    }
  })

  it('puts the ring on a rendered row and keeps the one-of fill behaviour', () => {
    render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: 'Row focus' }))
    const menu = screen.getByRole('menu', { name: 'Row focus' })

    for (const row of [screen.getByRole('menuitem', { name: 'One' }), screen.getByRole('menuitem', { name: 'Two' })]) {
      for (const token of tokens(MENU_ROW)) expect(row.classList.contains(token)).toBe(true)
      expect(row.classList.contains('focus-visible:outline-none')).toBe(false)
      expect(row.classList.contains('focus-visible:vy-focus-ring')).toBe(true)
    }

    // The fill stays one-of: the active row is never also the idle hover row.
    const active = screen.getByRole('menuitem', { name: 'One' })
    const idle = screen.getByRole('menuitem', { name: 'Two' })
    expect(active.classList.contains('bg-surface-2')).toBe(true)
    for (const token of tokens(MENU_ROW_IDLE)) expect(active.classList.contains(token)).toBe(false)
    for (const token of tokens(MENU_ROW_IDLE)) expect(idle.classList.contains(token)).toBe(true)
    for (const token of tokens(MENU_ROW_ACTIVE)) expect(idle.classList.contains(token)).toBe(false)
    expect(menu.getAttribute('role')).toBe('menu')
  })
})
