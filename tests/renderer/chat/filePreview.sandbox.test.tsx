/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FilePreview } from '@renderer/features/chat/components/FilePreview'

afterEach(() => {
  cleanup()
})

describe('FilePreview html sandbox toggle', () => {
  it('defaults to fully sandboxed with the toggle off', () => {
    const { container } = render(
      <FilePreview path="index.html" content="<h1>hi</h1>" binary={false} />
    )

    const iframe = container.querySelector('iframe')
    expect(iframe).toBeTruthy()
    expect(iframe!.getAttribute('sandbox')).toBe('')
    expect(iframe!.getAttribute('srcdoc')).toBe('<h1>hi</h1>')

    const toggle = screen.getByRole('button', { name: /enable scripts/i })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })

  it('flips sandbox to allow-scripts only (no allow-same-origin) when enabled', () => {
    const { container } = render(
      <FilePreview path="index.html" content="<h1>hi</h1>" binary={false} />
    )

    const before = container.querySelector('iframe')
    const toggle = screen.getByRole('button', { name: /enable scripts/i })
    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const after = container.querySelector('iframe')
    expect(after!.getAttribute('sandbox')).toBe('allow-scripts')
    // Remount, not attribute patch: Chromium does not reliably apply a
    // dynamically changed sandbox attribute to an already-loaded frame.
    expect(after).not.toBe(before)
    expect(after!.getAttribute('srcdoc')).toBe('<h1>hi</h1>')
  })

  it('toggles back off to the fully sandboxed frame', () => {
    const { container } = render(
      <FilePreview path="index.html" content="<h1>hi</h1>" binary={false} />
    )

    const toggle = screen.getByRole('button', { name: /enable scripts/i })
    fireEvent.click(toggle)
    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('iframe')!.getAttribute('sandbox')).toBe('')
  })

  it('labels the enabled state', () => {
    render(<FilePreview path="index.html" content="<h1>hi</h1>" binary={false} />)

    const toggle = screen.getByRole('button', { name: /enable scripts/i })
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: /scripts on/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^enable scripts$/i })).toBeNull()
  })
})
