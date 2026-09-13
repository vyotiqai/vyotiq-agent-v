/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { useFocusTrap } from '@renderer/lib/a11y/useFocusTrap'

function TrapFixture({ active }: { active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  useFocusTrap({ active, containerRef })
  return (
    <div>
      <button type="button">Outside</button>
      <div ref={containerRef} tabIndex={-1}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </div>
    </div>
  )
}

afterEach(() => {
  cleanup()
})

describe('useFocusTrap', () => {
  it('wraps Tab from last to first focusable', () => {
    render(<TrapFixture active />)
    const first = screen.getByRole('button', { name: 'First' })
    const last = screen.getByRole('button', { name: 'Last' })
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
  })

  it('wraps Shift+Tab from first to last focusable', () => {
    render(<TrapFixture active />)
    const first = screen.getByRole('button', { name: 'First' })
    const last = screen.getByRole('button', { name: 'Last' })
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})
