/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ToolApprovalOnboardingModal } from '@renderer/features/chat/components/ToolApprovalOnboardingModal'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
    this.open = false
  })
})

afterEach(() => {
  cleanup()
})

describe('ToolApprovalOnboardingModal', () => {
  it('renders mode choices when open, Mutating first with Recommended', () => {
    render(<ToolApprovalOnboardingModal open onChoose={vi.fn()} onDismiss={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'Tool approval' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Tool approval' })).toBeTruthy()
    const dialog = screen.getByRole('dialog', { name: 'Tool approval' })
    const modeButtons = within(dialog)
      .getAllByRole('button')
      .filter((el) => el.getAttribute('type') === 'button' && el.textContent !== 'Not now')
    // Order: Mutating, Off, All (Not now is separate)
    const labels = modeButtons.map((b) => b.textContent ?? '')
    expect(labels[0]).toMatch(/Mutating tools/i)
    expect(labels[0]).toMatch(/Recommended/i)
    expect(labels[1]).toMatch(/^Off/i)
    expect(labels[2]).toMatch(/All tools/i)
  })

  it('calls onChoose with selected mode', () => {
    const onChoose = vi.fn()
    render(<ToolApprovalOnboardingModal open onChoose={onChoose} onDismiss={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /mutating tools/i }))
    expect(onChoose).toHaveBeenCalledWith('mutating')
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
    expect(screen.getByRole('button', { name: /all tools/i })).toBeTruthy()
  })

  it('calls onDismiss from Not now', () => {
    const onDismiss = vi.fn()
    render(<ToolApprovalOnboardingModal open onChoose={vi.fn()} onDismiss={onDismiss} />)

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when closed', () => {
    render(<ToolApprovalOnboardingModal open={false} onChoose={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.queryByRole('heading', { name: 'Tool approval' })).toBeNull()
  })
})
