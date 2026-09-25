/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToolApprovalOnboardingModal } from '@renderer/features/chat/components/ToolApprovalOnboardingModal'

afterEach(() => {
  cleanup()
})

describe('ToolApprovalOnboardingModal', () => {
  it('asks what needs your OK, the recommended mode first and focused', async () => {
    render(<ToolApprovalOnboardingModal open onChoose={vi.fn()} onDismiss={vi.fn()} />)

    const dialog = screen.getByRole('dialog', { name: 'What needs your OK?' })
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy()
    const modes = within(dialog)
      .getAllByRole('button')
      .filter((el) => el.textContent !== 'Not now')
    expect(modes.map((b) => b.querySelector('span')?.textContent)).toEqual([
      'Edits and commands',
      'Every tool',
      'Unattended'
    ])
    expect(modes[0]!.textContent).toContain('Recommended. Reading is free; changing things asks first.')
    await waitFor(() => expect(document.activeElement).toBe(modes[0]))
  })

  it('says what still asks with approvals off', () => {
    const { rerender } = render(<ToolApprovalOnboardingModal open onChoose={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.getByRole('button', { name: /unattended/i }).textContent).toContain(
      'MCP tools and tools the agent writes still ask.'
    )
    rerender(<ToolApprovalOnboardingModal open onChoose={vi.fn()} onDismiss={vi.fn()} mcpProtection={false} />)
    const off = screen.getByRole('button', { name: /unattended/i })
    expect(off.textContent).toContain('Tools the agent writes still ask.')
    expect(off.textContent).not.toContain('MCP')
  })

  it('picks the mode clicked', () => {
    const onChoose = vi.fn()
    render(<ToolApprovalOnboardingModal open onChoose={onChoose} onDismiss={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /every tool/i }))
    expect(onChoose).toHaveBeenCalledWith('all')
    fireEvent.click(screen.getByRole('button', { name: /edits and commands/i }))
    expect(onChoose).toHaveBeenLastCalledWith('mutating')
  })

  it('shows a save error while keeping the choices available', () => {
    render(
      <ToolApprovalOnboardingModal
        open
        onChoose={vi.fn()}
        onDismiss={vi.fn()}
        error="Settings could not be saved."
      />
    )

    expect(screen.getByRole('alert').textContent).toContain('Settings could not be saved.')
    expect(screen.getByRole('button', { name: /every tool/i })).toBeTruthy()
  })

  it('Not now closes without a choice', () => {
    const onDismiss = vi.fn()
    const onChoose = vi.fn()
    render(<ToolApprovalOnboardingModal open onChoose={onChoose} onDismiss={onDismiss} />)

    expect(screen.getByText('Not now keeps your brief, unsent.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('every choice keeps its focus ring', () => {
    render(<ToolApprovalOnboardingModal open onChoose={vi.fn()} onDismiss={vi.fn()} />)
    for (const name of [/edits and commands/i, /every tool/i, /unattended/i]) {
      expect(screen.getByRole('button', { name }).className).toContain('focus-visible:vy-focus-ring')
    }
  })

  it('renders nothing when closed', () => {
    render(<ToolApprovalOnboardingModal open={false} onChoose={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
