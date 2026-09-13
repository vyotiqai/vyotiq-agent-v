/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
})
