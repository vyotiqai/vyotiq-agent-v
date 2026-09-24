/**
 * @vitest-environment jsdom
 */
import { useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ActionMenu, type ActionMenuItem } from '@renderer/lib/ui/ActionMenu'
import { MENU_ROW_ACTIVE, MENU_ROW_DISABLED, MENU_ROW_IDLE, MENU_ROW_TEXT } from '@renderer/lib/ui/menuStyles'

afterEach(() => {
  cleanup()
})

const REASON = '16 user rules is the most there can be.'

function Fixture({ onSelect }: { onSelect: (id: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const items: ActionMenuItem[] = [
    { id: 'user', label: 'User rule', disabled: true, disabledReason: REASON, onSelect: () => onSelect('user') },
    { id: 'project', label: 'Project rule', onSelect: () => onSelect('project') },
    { id: 'other', label: 'Other rule', onSelect: () => onSelect('other') }
  ]
  return (
    <ActionMenu
      aria-label="New rule"
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
          aria-haspopup={props['aria-haspopup']}
          onClick={props.onClick}
        >
          New rule
        </button>
      )}
    />
  )
}

function openMenu(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'New rule' }))
  return screen.getByRole('menu', { name: 'New rule' })
}

const tokens = (classes: string): string[] => classes.split(/\s+/).filter(Boolean)

describe('ActionMenu disabled items', () => {
  it('shows a disabled item with its reason, and choosing it does nothing', () => {
    const onSelect = vi.fn()
    render(<Fixture onSelect={onSelect} />)
    openMenu()
    const row = screen.getByRole('menuitem', {
      name: 'User rule',
      description: `Unavailable: ${REASON}`
    }) as HTMLButtonElement
    expect(row.disabled).toBe(true)
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.title).toBe(REASON)
    // One text weight and no fill: a disabled row is never also drawn as idle or active.
    for (const token of tokens(MENU_ROW_DISABLED)) expect(row.classList.contains(token)).toBe(true)
    for (const token of [...tokens(MENU_ROW_TEXT), ...tokens(MENU_ROW_IDLE), ...tokens(MENU_ROW_ACTIVE)]) {
      expect(row.classList.contains(token)).toBe(false)
    }

    fireEvent.click(row)
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: 'New rule' })).toBeTruthy()
  })

  it('names a choosable item by its label alone', () => {
    render(<Fixture onSelect={vi.fn()} />)
    openMenu()
    const row = screen.getByRole('menuitem', { name: 'Project rule' })
    expect(row.getAttribute('aria-describedby')).toBeNull()
    expect(row.getAttribute('aria-disabled')).toBeNull()
  })

  it('starts on the first item that can be chosen', async () => {
    const onSelect = vi.fn()
    render(<Fixture onSelect={onSelect} />)
    const menu = openMenu()
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Project rule' }).classList.contains(MENU_ROW_ACTIVE)).toBe(true)
    )
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('project')
  })

  it('never lands the keyboard on a disabled item', () => {
    const onSelect = vi.fn()
    render(<Fixture onSelect={onSelect} />)

    // Down from the last choosable item wraps past the disabled first one.
    let menu = openMenu()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(onSelect).toHaveBeenLastCalledWith('project')

    // Up from the first choosable item goes to the last, not the disabled one.
    menu = openMenu()
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(onSelect).toHaveBeenLastCalledWith('other')

    // Home is the first choosable item.
    menu = openMenu()
    fireEvent.keyDown(menu, { key: 'End' })
    fireEvent.keyDown(menu, { key: 'Home' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(onSelect).toHaveBeenLastCalledWith('project')

    expect(onSelect).not.toHaveBeenCalledWith('user')
  })

  it('has nothing to choose when every item is disabled', () => {
    const onSelect = vi.fn()
    function AllDisabled(): JSX.Element {
      const [open, setOpen] = useState(true)
      return (
        <ActionMenu
          aria-label="New rule"
          open={open}
          onOpenChange={setOpen}
          items={[{ id: 'user', label: 'User rule', disabled: true, disabledReason: REASON, onSelect }]}
          trigger={(props) => (
            <button ref={props.ref} type="button" onClick={props.onClick}>
              New rule
            </button>
          )}
        />
      )
    }
    render(<AllDisabled />)
    const menu = screen.getByRole('menu', { name: 'New rule' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
  })
})
