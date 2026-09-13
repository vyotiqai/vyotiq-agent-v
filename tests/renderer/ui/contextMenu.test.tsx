/**
 * @vitest-environment jsdom
 */
import { useRef, useState, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
