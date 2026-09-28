/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentInteractionMode } from '@shared/ipc'
import { MODES, nextMode, useCycleModeShortcut } from '@renderer/features/chat/components/composer/ModePicker'

afterEach(() => {
  cleanup()
})

/** The shortcut's host, as ModeSwitch mounts it: a root inside (or beside) the composer shell. */
function Host({
  mode,
  onModeChange,
  locked = false
}: {
  mode: AgentInteractionMode
  onModeChange: (mode: AgentInteractionMode) => void
  locked?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useCycleModeShortcut(ref, locked, (reverse) => onModeChange(nextMode(mode, reverse)))
  return <div ref={ref} />
}

describe('agent modes', () => {
  it('lists Agent, then Ask', () => {
    // Agent leads: it is what a task usually is, on every surface that lists them.
    expect(MODES.map((m) => m.label)).toEqual(['Agent', 'Ask'])
  })

  it('cycles between the two, the same hop either way', () => {
    expect(nextMode('agent', false)).toBe('ask')
    expect(nextMode('ask', false)).toBe('agent')
    // Two modes: forward and reverse are the same hop. Plan used to sit
    // between them, which is what made the two directions differ.
    expect(nextMode('agent', true)).toBe('ask')
  })

  it('falls back to Agent when handed a mode that no longer exists', () => {
    // @ts-expect-error legacy persisted value: Plan was merged into Agent.
    expect(nextMode('plan', false)).toBe('ask')
  })
})

describe('useCycleModeShortcut', () => {
  it('cycles with Ctrl+. and reverses with Shift', () => {
    const onModeChange = vi.fn()
    render(<Host mode="agent" onModeChange={onModeChange} />)
    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(onModeChange).toHaveBeenCalledWith('ask')
    onModeChange.mockClear()
    fireEvent.keyDown(window, { key: '.', ctrlKey: true, shiftKey: true })
    expect(onModeChange).toHaveBeenCalledWith('ask')
  })

  it('does nothing while locked', () => {
    const onModeChange = vi.fn()
    render(<Host mode="agent" onModeChange={onModeChange} locked />)
    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(onModeChange).not.toHaveBeenCalled()
  })

  it('does not cycle from a generic input', () => {
    const onModeChange = vi.fn()
    render(
      <>
        <input aria-label="Other field" />
        <Host mode="agent" onModeChange={onModeChange} />
      </>
    )
    fireEvent.keyDown(screen.getByLabelText('Other field'), { key: '.', ctrlKey: true })
    expect(onModeChange).not.toHaveBeenCalled()
  })

  it('cycles while focus sits in the composer shell (live combobox target)', () => {
    const onModeChange = vi.fn()
    const { getByRole } = render(
      <div data-composer-shell="">
        <div role="combobox" aria-label="Instruction" aria-expanded="false" aria-controls="test-listbox" contentEditable tabIndex={0} />
        <Host mode="agent" onModeChange={onModeChange} />
      </div>
    )
    getByRole('combobox', { name: 'Instruction' }).focus()
    fireEvent.keyDown(getByRole('combobox', { name: 'Instruction' }), { key: '.', ctrlKey: true })
    expect(onModeChange).toHaveBeenCalledWith('ask')
  })

  it('answers the command palette’s cycleMode command', () => {
    const onModeChange = vi.fn()
    render(<Host mode="ask" onModeChange={onModeChange} />)
    window.dispatchEvent(new CustomEvent('vyotiq:command', { detail: { id: 'cycleMode' } }))
    expect(onModeChange).toHaveBeenCalledWith('agent')
  })

  it('leaves split panes that are not focused alone on the palette command', () => {
    const focused = vi.fn()
    const other = vi.fn()
    render(
      <>
        <div data-chat-pane="" data-chat-pane-focused="1">
          <Host mode="agent" onModeChange={focused} />
        </div>
        <div data-chat-pane="" data-chat-pane-focused="0">
          <Host mode="agent" onModeChange={other} />
        </div>
      </>
    )
    window.dispatchEvent(new CustomEvent('vyotiq:command', { detail: { id: 'cycleMode' } }))
    expect(focused).toHaveBeenCalledWith('ask')
    expect(other).not.toHaveBeenCalled()
  })
})
