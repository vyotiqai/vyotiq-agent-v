/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Icon } from '@renderer/lib/icons'
import { Alert, linkifyAlertText } from '@renderer/lib/ui/Alert'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('linkifyAlertText', () => {
  it('splits text around https URLs', () => {
    const onOpen = vi.fn()
    const nodes = linkifyAlertText(
      'Fix at https://openrouter.ai/settings/privacy then retry.',
      onOpen
    )
    const { container } = render(<div>{nodes}</div>)
    const link = container.querySelector('button')
    expect(link?.textContent).toBe('https://openrouter.ai/settings/privacy')
    fireEvent.click(link!)
    expect(onOpen).toHaveBeenCalledWith('https://openrouter.ai/settings/privacy')
  })
})

describe('Alert', () => {
  it('opens https links via shellOpenExternal', () => {
    const shellOpenExternal = vi.fn(async () => ({ ok: true as const, data: undefined }))
    vi.stubGlobal('vyotiq', { shellOpenExternal })

    render(
      <Alert>
        No endpoints. Configure: https://openrouter.ai/settings/privacy
      </Alert>
    )

    fireEvent.click(screen.getByRole('button', { name: /openrouter\.ai\/settings\/privacy/i }))
    expect(shellOpenExternal).toHaveBeenCalledWith('https://openrouter.ai/settings/privacy')
  })

  it('leaves non-string children unchanged', () => {
    render(
      <Alert>
        <span data-testid="custom">custom</span>
      </Alert>
    )
    expect(screen.getByTestId('custom').textContent).toBe('custom')
  })

  it('puts danger on the danger tint, led by a warning icon, with no invented border', () => {
    render(<Alert>Save failed.</Alert>)
    const alert = screen.getByRole('alert')
    expect(alert.classList.contains('bg-danger-soft')).toBe(true)
    expect(alert.classList.contains('text-danger')).toBe(true)
    expect(alert.className).not.toMatch(/border-danger\/|bg-surface\b/)
    expect(alert.firstElementChild?.innerHTML).toBe(iconMarkup('warning'))
  })

  it('outlines info and leads it with an info icon, so tone is never hue alone', () => {
    render(<Alert variant="info">Recheck the provider.</Alert>)
    const status = screen.getByRole('status')
    expect(status.classList.contains('border-border')).toBe(true)
    expect(status.className).not.toMatch(/bg-surface\b/)
    expect(status.firstElementChild?.innerHTML).toBe(iconMarkup('info'))
  })

  it('gives the dismiss button one hover fill and the alert its colour', () => {
    const onDismiss = vi.fn()
    render(<Alert onDismiss={onDismiss}>Save failed.</Alert>)
    const dismiss = screen.getByRole('button', { name: 'Dismiss' })
    expect(dismiss.className).not.toMatch(/hover:bg-surface-2|text-danger|text-muted/)
    expect(dismiss.className.match(/hover:bg-/g)).toHaveLength(1)
    fireEvent.click(dismiss)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('rings a linkified URL on keyboard focus', () => {
    render(<Alert>See https://example.com/help</Alert>)
    const link = screen.getByRole('button', { name: 'https://example.com/help' })
    expect(link.classList.contains('focus-visible:vy-focus-ring')).toBe(true)
  })

  it('lays actions after the body instead of inside it', () => {
    render(
      <Alert variant="info" actions={<button type="button">Recheck</button>}>
        <span>Provider unreachable</span>
      </Alert>
    )
    const status = screen.getByRole('status')
    const action = screen.getByRole('button', { name: 'Recheck' })
    const text = screen.getByText('Provider unreachable')
    expect(status.contains(action)).toBe(true)
    expect(text.parentElement?.contains(action)).toBe(false)
    // The row keeps its own alignment: nothing a caller would override.
    expect(status.className.match(/\bitems-/g)).toHaveLength(1)
  })
})

function iconMarkup(name: 'warning' | 'info'): string {
  const { container, unmount } = render(<Icon name={name} size={14} />)
  const html = container.querySelector('svg')!.innerHTML
  unmount()
  return html
}
