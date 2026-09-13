/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AgentBrowserPanel } from '@renderer/features/chat/components/AgentBrowserPanel'
import { BROWSER_RECENTS_KEY } from '@renderer/features/chat/components/browserRecents'

describe('AgentBrowserPanel visibility', () => {
  const browserSetBounds = vi.fn().mockResolvedValue({ ok: true, data: true })

  beforeEach(() => {
    browserSetBounds.mockClear()
    localStorage.removeItem(BROWSER_RECENTS_KEY)
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            open: false,
            url: '',
            title: '',
            navigating: false,
            tabs: [],
            canGoBack: false,
            canGoForward: false
          }
        }),
        onBrowserState: vi.fn().mockReturnValue(() => {}),
        browserSetBounds
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('clears native bounds when visible becomes false', () => {
    const { rerender } = render(<AgentBrowserPanel visible={true} />)
    browserSetBounds.mockClear()
    rerender(<AgentBrowserPanel visible={false} />)
    expect(browserSetBounds).toHaveBeenCalledWith(null)
  })

  it('surfaces browserGetState failures', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        browserGetState: vi.fn().mockResolvedValue({ ok: false, error: 'Browser crashed' }),
        onBrowserState: vi.fn().mockReturnValue(() => {}),
        browserSetBounds
      }
    })
    const { findByText } = render(<AgentBrowserPanel visible={true} />)
    expect(await findByText(/Browser state unavailable: Browser crashed/)).toBeTruthy()
  })

  it('shows agent busy banner with Take control', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            open: true,
            url: 'https://example.com',
            title: 'Example',
            navigating: false,
            agentBusy: true,
            userControl: false,
            tabs: [{ id: 't1', title: 'Example', url: 'https://example.com', active: true }],
            canGoBack: false,
            canGoForward: false
          }
        }),
        onBrowserState: vi.fn().mockReturnValue(() => {}),
        browserSetBounds: vi.fn().mockResolvedValue({ ok: true, data: true }),
        browserTakeControl: vi.fn().mockResolvedValue({ ok: true, data: true })
      }
    })
    const { findByText, findByLabelText } = render(<AgentBrowserPanel visible={true} />)
    expect(await findByText('Agent is browsing…')).toBeTruthy()
    expect(await findByText('Take control')).toBeTruthy()
    expect(await findByLabelText('Search or enter URL')).toBeTruthy()
  })

  it('updates recents title when title arrives for the same URL', async () => {
    let push: ((state: unknown) => void) | undefined
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            open: true,
            url: 'https://example.com/page',
            title: '',
            navigating: false,
            agentBusy: false,
            userControl: false,
            tabs: [{ id: 't1', title: '', url: 'https://example.com/page', active: true }],
            canGoBack: false,
            canGoForward: false
          }
        }),
        onBrowserState: vi.fn().mockImplementation((cb: (s: unknown) => void) => {
          push = cb
          return () => undefined
        }),
        browserSetBounds: vi.fn().mockResolvedValue({ ok: true, data: true }),
        browserClose: vi.fn().mockResolvedValue({ ok: true, data: true })
      }
    })
    render(<AgentBrowserPanel visible={true} />)
    await waitFor(() => {
      const raw = localStorage.getItem(BROWSER_RECENTS_KEY)
      expect(raw).toBeTruthy()
    })
    push?.({
      open: true,
      url: 'https://example.com/page',
      title: 'Example Page',
      navigating: false,
      agentBusy: false,
      userControl: false,
      tabs: [{ id: 't1', title: 'Example Page', url: 'https://example.com/page', active: true }],
      canGoBack: false,
      canGoForward: false
    })
    await waitFor(() => {
      const items = JSON.parse(localStorage.getItem(BROWSER_RECENTS_KEY) ?? '[]') as {
        title: string
      }[]
      expect(items[0]?.title).toBe('Example Page')
    })
  })

  it('Close browser menu calls browserClose and onClose', async () => {
    const browserClose = vi.fn().mockResolvedValue({ ok: true, data: true })
    const onClose = vi.fn()
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            open: true,
            url: 'https://example.com',
            title: 'Example',
            navigating: false,
            agentBusy: false,
            userControl: false,
            tabs: [{ id: 't1', title: 'Example', url: 'https://example.com', active: true }],
            canGoBack: false,
            canGoForward: false
          }
        }),
        onBrowserState: vi.fn().mockReturnValue(() => {}),
        browserSetBounds: vi.fn().mockResolvedValue({ ok: true, data: true }),
        browserClose
      }
    })
    const { findByLabelText, findByText } = render(
      <AgentBrowserPanel visible={true} onClose={onClose} />
    )
    fireEvent.click(await findByLabelText('More actions'))
    fireEvent.click(await findByText('Close browser'))
    expect(browserClose).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('surfaces navigation control failures', async () => {
    const browserBack = vi.fn().mockResolvedValue({ ok: false, error: 'Workspace is closed' })
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            open: true,
            url: 'https://example.com',
            title: 'Example',
            navigating: false,
            tabs: [{ id: 't1', title: 'Example', url: 'https://example.com', active: true }],
            canGoBack: true,
            canGoForward: false
          }
        }),
        onBrowserState: vi.fn().mockReturnValue(() => {}),
        browserSetBounds,
        browserBack
      }
    })
    const { findByLabelText, findByText } = render(<AgentBrowserPanel visible={true} />)
    fireEvent.click(await findByLabelText('Back'))
    expect(browserBack).toHaveBeenCalled()
    expect(await findByText('Workspace is closed')).toBeTruthy()
  })

  it('searches with the Settings search engine from the address bar', async () => {
    const browserNavigate = vi.fn().mockResolvedValue({ ok: true, data: true })
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            open: false,
            url: '',
            title: '',
            navigating: false,
            tabs: [],
            canGoBack: false,
            canGoForward: false
          }
        }),
        onBrowserState: vi.fn().mockReturnValue(() => {}),
        browserSetBounds,
        getSettings: vi.fn().mockResolvedValue({
          ok: true,
          data: { searchEngine: 'duckduckgo' }
        }),
        browserNavigate
      }
    })
    const { findByLabelText } = render(<AgentBrowserPanel visible={true} />)
    const input = await findByLabelText('Search or enter URL')
    fireEvent.change(input, { target: { value: 'hello world' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => {
      expect(browserNavigate).toHaveBeenCalledWith(
        'https://duckduckgo.com/?q=hello%20world',
        undefined
      )
    })
  })

  it('exposes viewport size presets', async () => {
    const { findByLabelText } = render(<AgentBrowserPanel visible={true} />)
    const select = (await findByLabelText('Viewport size')) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'iphone' } })
    expect(select.value).toBe('iphone')
    expect(document.querySelector('[data-browser-viewport="iphone"]')).toBeTruthy()
  })
})
