/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ToolApprovalMode } from '@shared/ipc'
import { ApprovalModeChoice, approvalModes } from '@renderer/features/setup/ApprovalModeChoice'

afterEach(cleanup)

function Controlled({ initial = 'mutating' as ToolApprovalMode, onChange = vi.fn() }) {
  const [value, setValue] = useState<ToolApprovalMode>(initial)
  return (
    <ApprovalModeChoice
      value={value}
      onChange={(mode) => {
        setValue(mode)
        onChange(mode)
      }}
    />
  )
}

describe('approvalModes', () => {
  it('never calls approvals-off "nothing": what still asks is said', () => {
    const off = approvalModes(true).find((m) => m.mode === 'off')!
    expect(off.label).toBe('Unattended')
    expect(off.description).toBe('For runs nobody is watching. MCP tools and tools the agent writes still ask.')
    expect(approvalModes(false).find((m) => m.mode === 'off')!.description).toBe(
      'For runs nobody is watching. Tools the agent writes still ask.'
    )
  })
})

describe('ApprovalModeChoice', () => {
  it('is one radio group, the choice checked and the only tab stop', () => {
    render(<Controlled />)
    const group = screen.getByRole('radiogroup', { name: 'What needs your OK' })
    const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'))
    expect(radios.map((r) => r.querySelector('span:last-child span')?.textContent)).toEqual([
      'Edits and commands',
      'Every tool',
      'Unattended'
    ])
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1])
  })

  it('arrow keys move the choice and the focus, and wrap', () => {
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)
    const first = screen.getByRole('radio', { name: /Edits and commands/ })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith('all')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Every tool/ }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('off')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith('mutating')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith('off')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('mutating')
  })

  it('the chosen row is filled and the others fill only on hover — never both classes', () => {
    render(<Controlled initial="all" />)
    const on = screen.getByRole('radio', { name: /Every tool/ })
    const off = screen.getByRole('radio', { name: /Unattended/ })
    expect(on.classList.contains('bg-surface')).toBe(true)
    expect(on.classList.contains('hover:bg-surface')).toBe(false)
    expect(off.classList.contains('hover:bg-surface')).toBe(true)
    expect(off.classList.contains('bg-surface')).toBe(false)
    expect(on.className).toContain('focus-visible:vy-focus-ring')
  })
})
