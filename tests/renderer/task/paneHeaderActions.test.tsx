/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PaneHeaderActions } from '@renderer/features/task/TaskPane'

afterEach(cleanup)

describe('PaneHeaderActions', () => {
  it('keeps the inspector toggle there, lit, while the inspector is open', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<PaneHeaderActions title="Fix tests" inspectorToggle={{ open: true, onToggle }} />)
    const toggle = screen.getByRole('button', { name: /^Hide inspector/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // Lit while open; its words and aria-expanded carry the state, not a third "pressed".
    expect(toggle.classList.contains('bg-surface-2')).toBe(true)
    expect(toggle.hasAttribute('aria-pressed')).toBe(false)
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)

    rerender(<PaneHeaderActions title="Fix tests" inspectorToggle={{ open: false, onToggle }} />)
    const shown = screen.getByRole('button', { name: /^Show inspector/ })
    expect(shown.getAttribute('aria-expanded')).toBe('false')
    expect(shown.classList.contains('bg-surface-2')).toBe(false)
  })

  it('offers no toggle on a pane away from the inspector', () => {
    render(<PaneHeaderActions title="Fix tests" onClosePane={() => {}} />)
    expect(screen.queryByRole('button', { name: /inspector/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close Fix tests' })).toBeTruthy()
  })
})
