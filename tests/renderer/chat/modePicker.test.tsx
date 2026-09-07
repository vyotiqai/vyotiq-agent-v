/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModePicker } from '@renderer/features/chat/components/composer/ModePicker'

afterEach(() => {
  cleanup()
})

describe('ModePicker', () => {
  it('renders Agent without truncate clipping on the short label', () => {
    render(<ModePicker mode="agent" onModeChange={vi.fn()} />)
    const button = screen.getByRole('button', { name: /Agent mode/i })
    expect(button.textContent).toBe('Agent')
    expect(button.className).not.toMatch(/\btruncate\b/)
    const label = button.querySelector('span')
    expect(label).toBeTruthy()
    expect(label!.className).not.toMatch(/\btruncate\b/)
    expect(label!.className).toMatch(/leading-tight/)
  })

  it('uses foreground color for Agent mode (not muted)', () => {
    render(<ModePicker mode="agent" onModeChange={vi.fn()} />)
    const button = screen.getByRole('button', { name: /Agent mode/i })
    expect(button.className).toMatch(/\btext-fg\b/)
    expect(button.className).not.toMatch(/\btext-muted\b/)
  })

  it('cycles to Ask on click', () => {
    const onModeChange = vi.fn()
    render(<ModePicker mode="agent" onModeChange={onModeChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent mode/i }))
    expect(onModeChange).toHaveBeenCalledWith('ask')
  })

  it('cycles with Ctrl+. and reverses with Shift', () => {
    const onModeChange = vi.fn()
    render(<ModePicker mode="agent" onModeChange={onModeChange} />)
    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(onModeChange).toHaveBeenCalledWith('ask')
    onModeChange.mockClear()
    fireEvent.keyDown(window, { key: '.', ctrlKey: true, shiftKey: true })
    expect(onModeChange).toHaveBeenCalledWith('plan')
  })

  it('does not cycle from a generic input', () => {
    const onModeChange = vi.fn()
    render(
      <>
        <input aria-label="Other field" />
        <ModePicker mode="agent" onModeChange={onModeChange} />
      </>
    )
    fireEvent.keyDown(screen.getByLabelText('Other field'), { key: '.', ctrlKey: true })
    expect(onModeChange).not.toHaveBeenCalled()
  })

  it('cycles while focus sits in the composer shell (live combobox target)', () => {
    const onModeChange = vi.fn()
    const { getByRole } = render(
      <div data-composer-shell="">
        <div role="combobox" aria-label="Message" aria-expanded="false" aria-controls="test-listbox" contentEditable tabIndex={0} />
        <ModePicker mode="agent" onModeChange={onModeChange} />
      </div>
    )
    getByRole('combobox', { name: /^Message$/i }).focus()
    fireEvent.keyDown(getByRole('combobox', { name: /^Message$/i }), { key: '.', ctrlKey: true })
    expect(onModeChange).toHaveBeenCalledWith('ask')
  })
})
