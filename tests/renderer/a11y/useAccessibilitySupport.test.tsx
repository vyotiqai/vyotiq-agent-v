/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useAccessibilitySupport } from '@renderer/lib/a11y/useAccessibilitySupport'

function Harness() {
  useAccessibilitySupport()
  return null
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.a11y
  // @ts-expect-error test cleanup
  if (window.vyotiq && 'getAccessibilitySupportState' in window.vyotiq) delete window.vyotiq.getAccessibilitySupportState
  // @ts-expect-error test cleanup
  if (window.vyotiq && 'onAccessibilitySupportChanged' in window.vyotiq) delete window.vyotiq.onAccessibilitySupportChanged
})

describe('useAccessibilitySupport', () => {
  it('sets data-a11y="on" from the initial query and follows change events', async () => {
    let listener: ((payload: { enabled: boolean }) => void) | null = null
    // @ts-expect-error mocked preload API
    window.vyotiq = {
      getAccessibilitySupportState: vi.fn().mockResolvedValue({ ok: true, data: { enabled: true } }),
      onAccessibilitySupportChanged: vi.fn().mockImplementation((cb) => {
        listener = cb
        return vi.fn()
      })
    }
    render(<Harness />)
    await waitFor(() => expect(document.documentElement.dataset.a11y).toBe('on'))
    listener!({ enabled: false })
    await waitFor(() => expect(document.documentElement.dataset.a11y).toBe('off'))
    listener!({ enabled: true })
    await waitFor(() => expect(document.documentElement.dataset.a11y).toBe('on'))
  })

  it('tolerates missing preload APIs without throwing', async () => {
    // @ts-expect-error no preload in this environment
    window.vyotiq = undefined
    expect(() => render(<Harness />)).not.toThrow()
    await waitFor(() => expect(document.documentElement.dataset.a11y ?? '').toBe(''))
  })
})
