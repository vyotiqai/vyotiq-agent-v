/**
 * @vitest-environment jsdom
 */
import { useRef, useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, isInaccessible, render, screen, waitFor } from '@testing-library/react'
import { ContextMenu, type ContextMenuAnchor, type ContextMenuItem } from '@renderer/lib/ui/ContextMenu'

afterEach(() => {
  cleanup()
})

function Fixture(): JSX.Element {
  const targetRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null)
  const onSelect = vi.fn()
  const items: ContextMenuItem[] = [
    { id: 'first', label: 'First action', onSelect },
    { type: 'separator', id: 'separator' },
    { id: 'second', label: 'Second action', onSelect }
  ]
  return (
    <>
      <button
        ref={targetRef}
        type="button"
        onContextMenu={(event) => {
          event.preventDefault()
          setAnchor({ x: event.clientX, y: event.clientY })
        }}
      >
        Target
      </button>
      <ContextMenu
        anchor={anchor}
        items={items}
        onClose={() => setAnchor(null)}
        returnFocusRef={targetRef}
      />
    </>
  )
}

describe('ContextMenu', () => {
  it('supports keyboard navigation and restores focus on Escape', async () => {
    render(<Fixture />)
    const target = screen.getByRole('button', { name: 'Target' })
    fireEvent.contextMenu(target, { clientX: 20, clientY: 20 })

    const menu = screen.getByRole('menu')
    expect(menu).toBeTruthy()
    expect(menu.getAttribute('style')).toContain('max-height: calc(100vh - 1rem)')
    await waitFor(() => expect(document.activeElement?.textContent).toBe('First action'))

    fireEvent.keyDown(document, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Second action'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(target))
  })
})

const REASON = 'Close the file before renaming it.'
const ITEMS: ContextMenuItem[] = [
  { id: 'rename', label: 'Rename', disabled: true, disabledReason: REASON, onSelect: vi.fn() },
  { id: 'copy', label: 'Copy path', onSelect: vi.fn() }
]

function renderMenu(): void {
  render(<ContextMenu anchor={{ x: 20, y: 20 }} items={ITEMS} onClose={vi.fn()} />)
}

describe('ContextMenu disabled items', () => {
  it('names a disabled item by its label and describes it by its reason', () => {
    renderMenu()
    const row = screen.getByRole('menuitem', {
      name: 'Rename',
      description: `Unavailable: ${REASON}`
    })
    // aria-label pins the name wherever the reason sits, so check its place too: outside the
    // row and out of the tree, a screen reader hears it once, as the description.
    const reason = document.getElementById(row.getAttribute('aria-describedby')!)!
    expect(row.contains(reason)).toBe(false)
    expect(isInaccessible(reason)).toBe(true)
  })

  it('names an enabled item by its label alone', () => {
    renderMenu()
    const row = screen.getByRole('menuitem', { name: 'Copy path' })
    expect(row.getAttribute('aria-describedby')).toBeNull()
  })
})
