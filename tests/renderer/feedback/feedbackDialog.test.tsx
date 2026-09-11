/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FeedbackDialog } from '@renderer/features/feedback'

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
  // @ts-expect-error test bridge teardown
  delete window.vyotiq
})

function setBridge(compose: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { vyotiq: unknown }).vyotiq = {
    feedback: { compose }
  }
}

function fillForm(): void {
  fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'feature' } })
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Search in logs' } })
  fireEvent.change(screen.getByLabelText('Message'), {
    target: { value: 'Please add full-text search over log files.' }
  })
}

describe('FeedbackDialog', () => {
  it('disables submit until title and message are filled', () => {
    setBridge(vi.fn())
    render(<FeedbackDialog open onClose={vi.fn()} />)

    expect(
      screen.getByRole('button', { name: 'Send feedback' }).hasAttribute('disabled')
    ).toBe(true)

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Only a title' } })
    expect(
      screen.getByRole('button', { name: 'Send feedback' }).hasAttribute('disabled')
    ).toBe(true)

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Now a message' } })
    expect(
      screen.getByRole('button', { name: 'Send feedback' }).hasAttribute('disabled')
    ).toBe(false)
  })

  it('submits the typed payload including includeDiagnostics and shows the confirmation state', async () => {
    const compose = vi.fn(async () => ({
      ok: true as const,
      mailto: 'mailto:support@vyotiq.com?subject=hi'
    }))
    setBridge(compose)
    render(<FeedbackDialog open onClose={vi.fn()} />)

    fillForm()
    fireEvent.click(screen.getByLabelText('Include basic diagnostics (app version, OS)'))
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))

    await waitFor(() => {
      expect(compose).toHaveBeenCalledWith({
        type: 'feature',
        title: 'Search in logs',
        message: 'Please add full-text search over log files.',
        includeDiagnostics: true
      })
    })
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(screen.getByText(/email client should have opened/i)).toBeTruthy()
    // Fallback link remains available even on success.
    expect(screen.getByText('Open email manually')).toBeTruthy()
  })

  it('shows the mailto fallback link when compose reports failure', async () => {
    const compose = vi.fn(async () => ({ ok: false as const, mailto: 'mailto:support@vyotiq.com?x=1' }))
    setBridge(compose)
    render(<FeedbackDialog open onClose={vi.fn()} />)

    fillForm()
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toBeTruthy()
    const link = screen.getByText('Open pre-filled email').closest('a')
    expect(link?.getAttribute('href')).toBe('mailto:support@vyotiq.com?x=1')
  })

  it('falls back to a client-built mailto when the bridge is unavailable', async () => {
    ;(window as unknown as { vyotiq: unknown }).vyotiq = {}
    render(<FeedbackDialog open onClose={vi.fn()} />)

    fillForm()
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))

    const alert = await screen.findByRole('alert')
    const link = screen.getByText('Open pre-filled email').closest('a')
    expect(link?.getAttribute('href')).toContain('mailto:support@vyotiq.com')
    expect(link?.getAttribute('href')).toContain(encodeURIComponent('Search in logs'))
    expect(alert).toBeTruthy()
  })

  it('closes on Escape', () => {
    setBridge(vi.fn())
    const onClose = vi.fn()
    render(<FeedbackDialog open onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
