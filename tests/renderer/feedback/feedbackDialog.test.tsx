/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FEEDBACK_TITLE_MAX } from '@shared/ipc'
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
  fireEvent.click(screen.getByRole('radio', { name: 'Feature request' }))
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
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include basic diagnostics (app version, OS)' }))
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

  it('sits on the redesigned frame: menu surface, 48px header, footer row', () => {
    setBridge(vi.fn())
    render(<FeedbackDialog open onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Send feedback' })
    expect(document.querySelector('dialog')).toBeNull()
    expect(dialog.classList.contains('vy-menu')).toBe(true)
    const title = screen.getByRole('heading', { name: 'Send feedback' })
    expect(title.classList.contains('text-heading')).toBe(true)
    expect(title.parentElement!.classList.contains('h-12')).toBe(true)
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    const submit = screen.getByRole('button', { name: 'Send feedback' })
    expect(submit.closest('form')).toBeNull()
    // Disabled until the form is filled, so a tooltip span wraps it.
    expect(submit.closest('.border-t')).toBe(dialog.lastElementChild)
    // The type is a one-glance choice, not a native select.
    expect(document.querySelector('select')).toBeNull()
    expect(screen.getByRole('radiogroup', { name: 'Type' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Bug report' }).getAttribute('aria-checked')).toBe('true')
  })

  it('keeps one focus treatment on the message field and counts in tabular mono', () => {
    setBridge(vi.fn())
    render(<FeedbackDialog open onClose={vi.fn()} />)
    const field = screen.getByLabelText('Message')
    expect(field.className).not.toMatch(/outline-none/)
    expect(field.classList.contains('focus-visible:vy-focus-ring')).toBe(true)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'abc' } })
    const counter = screen.getByText(`3/${FEEDBACK_TITLE_MAX}`)
    expect(counter.className).toMatch(/\bfont-mono\b/)
    expect(counter.className).toMatch(/\btnum\b/)
    expect(counter.className).not.toMatch(/text-\[/)
  })

  it('submits from the footer when the title field takes Enter', async () => {
    const compose = vi.fn(async () => ({ ok: true as const, mailto: 'mailto:x' }))
    setBridge(compose)
    render(<FeedbackDialog open onClose={vi.fn()} />)
    fillForm()
    fireEvent.submit(screen.getByLabelText('Title').closest('form')!)
    await waitFor(() => expect(compose).toHaveBeenCalledTimes(1))
  })

  it('closes on Escape', () => {
    setBridge(vi.fn())
    const onClose = vi.fn()
    render(<FeedbackDialog open onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('saves a diagnostics bundle to attach, and says where', async () => {
    const exportDiagnostics = vi.fn(async () => ({
      ok: true as const,
      data: { saved: true as const, fileName: 'vyotiq-diagnostics-20261002-1430.zip', bytes: 1200, files: [] }
    }))
    ;(window as unknown as { vyotiq: unknown }).vyotiq = { feedback: { compose: vi.fn() }, exportDiagnostics }
    render(<FeedbackDialog open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }))

    expect(exportDiagnostics).toHaveBeenCalledTimes(1)
    expect((await screen.findByRole('status')).textContent).toBe(
      'Saved vyotiq-diagnostics-20261002-1430.zip. Attach it to the email.'
    )
  })
})
