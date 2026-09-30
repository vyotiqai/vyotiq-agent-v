/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentBrowserPanel, splitBrowserUrl } from '@renderer/features/chat/components/AgentBrowserPanel'
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
    expect(await findByText('Agent is browsing')).toBeTruthy()
    // With no browser call in flight, the page it is on says where.
    expect(document.querySelector('[data-browser-agent-banner]')?.textContent).toContain('Agent is browsing — Example')
    expect(await findByText('Take control')).toBeTruthy()
    expect(await findByLabelText('Search or enter URL')).toBeTruthy()
  })

  it('starts with the 40px address row and puts the tabs under it', async () => {
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
            userControl: true,
            tabs: [
              { id: 't1', title: 'Example', url: 'https://example.com', active: true },
              { id: 't2', title: 'Docs', url: 'https://example.com/docs', active: false }
            ],
            canGoBack: false,
            canGoForward: false
          }
        }),
        onBrowserState: vi.fn().mockReturnValue(() => {}),
        browserSetBounds: vi.fn().mockResolvedValue({ ok: true, data: true })
      }
    })
    render(<AgentBrowserPanel visible={true} />)
    const tabs = await waitFor(() => {
      const el = document.querySelector('[data-browser-tabs]')
      expect(el).not.toBeNull()
      return el!
    })
    const panel = document.querySelector('[data-agent-browser-panel]')!
    const firstRow = [...panel.children].find((el) => el.tagName !== 'P')!
    expect(firstRow.classList.contains('h-10')).toBe(true)
    expect(firstRow.contains(screen.getByLabelText('Search or enter URL'))).toBe(true)
    expect(firstRow.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says what the agent is doing in the browser when a call is in flight', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            open: true,
            url: 'http://localhost:4321/use-cases',
            title: 'Use cases',
            navigating: false,
            agentBusy: true,
            userControl: false,
            tabs: [{ id: 't1', title: 'Use cases', url: 'http://localhost:4321/use-cases', active: true }],
            canGoBack: false,
            canGoForward: false
          }
        }),
        onBrowserState: vi.fn().mockReturnValue(() => {}),
        browserSetBounds: vi.fn().mockResolvedValue({ ok: true, data: true })
      }
    })
    render(<AgentBrowserPanel visible={true} agentAction="Clicking Incident to PR" />)
    await waitFor(() => {
      expect(document.querySelector('[data-browser-agent-banner]')?.textContent).toContain(
        'Agent is browsing — Clicking Incident to PR'
      )
    })
    // The address shows its host quiet and its path in full.
    const address = document.querySelector('[data-browser-address]')
    expect(address?.textContent).toBe('localhost:4321/use-cases')
    expect(address?.querySelector('.text-fg')?.textContent).toBe('/use-cases')
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

  it('Close browser menu calls browserClose', async () => {
    const browserClose = vi.fn().mockResolvedValue({ ok: true, data: true })
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
    const { findByLabelText, findByText } = render(<AgentBrowserPanel visible={true} />)
    fireEvent.click(await findByLabelText('More actions'))
    fireEvent.click(await findByText('Close browser'))
    expect(browserClose).toHaveBeenCalled()
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
    const { findByText } = render(<AgentBrowserPanel visible={true} />)
    // Back enables once the page state says there is somewhere to go.
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(browserBack).toHaveBeenCalled()
    expect(await findByText('Workspace is closed')).toBeTruthy()
    // A failure is an alert with an icon, not the quiet confirmation line.
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Workspace is closed')
    expect(alert.querySelector('svg')).toBeTruthy()
  })

  it('walks the recents list with the arrow keys and opens the one it is on', async () => {
    const now = Date.now()
    localStorage.setItem(
      BROWSER_RECENTS_KEY,
      JSON.stringify([
        { url: 'https://a.example/', title: 'A', visitedAt: now },
        { url: 'https://b.example/', title: 'B', visitedAt: now - 1000 }
      ])
    )
    const browserNavigate = vi.fn().mockResolvedValue({ ok: true, data: true })
    window.vyotiq.browserNavigate = browserNavigate
    render(<AgentBrowserPanel visible={true} />)
    const input = await screen.findByLabelText('Search or enter URL')
    fireEvent.focus(input)
    const list = await screen.findByRole('listbox', { name: 'Recent pages' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const second = list.querySelector('#browser-recent-1') as HTMLElement
    expect(second.getAttribute('aria-selected')).toBe('true')
    expect(input.getAttribute('aria-activedescendant')).toBe('browser-recent-1')
    expect(second.classList.contains('bg-surface-2')).toBe(true)
    expect(second.classList.contains('hover:bg-surface')).toBe(false)
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(browserNavigate).toHaveBeenCalledWith('https://b.example/', undefined)
    })
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

  it('switches between Fit and a phone width, with every preset in the menu', async () => {
    localStorage.removeItem('vyotiq.browserViewport')
    render(<AgentBrowserPanel visible={true} />)
    const group = await screen.findByRole('radiogroup', { name: 'Viewport size' })
    expect(group.textContent).toBe('Fit390')
    fireEvent.click(screen.getByRole('radio', { name: '390' }))
    expect(document.querySelector('[data-browser-viewport="iphone"]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /768×1024/ }))
    expect(document.querySelector('[data-browser-viewport="ipad"]')).toBeTruthy()
    // The segmented control follows the width in use.
    expect(screen.getByRole('radio', { name: '768' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Fit' }))
    expect(document.querySelector('[data-browser-viewport="fit"]')).toBeTruthy()
  })
})

describe('AgentBrowserPanel Type in the page', () => {
  const page = {
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

  function stub(state: Record<string, unknown>, browserFocus = vi.fn().mockResolvedValue({ ok: true, data: true })) {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        browserGetState: vi.fn().mockResolvedValue({ ok: true, data: state }),
        onBrowserState: vi.fn().mockReturnValue(() => {}),
        browserSetBounds: vi.fn().mockResolvedValue({ ok: true, data: true }),
        browserFocus
      }
    })
    return browserFocus
  }

  afterEach(() => {
    cleanup()
  })

  it('hands the page keyboard focus from the address row', async () => {
    const browserFocus = stub(page)
    render(<AgentBrowserPanel visible={true} />)
    const button = await screen.findByRole('button', { name: 'Type in the page' })
    const row = document.querySelector('[data-agent-browser-panel] > .h-10')
    expect(row?.contains(button)).toBe(true)
    fireEvent.click(button)
    expect(browserFocus).toHaveBeenCalledTimes(1)
  })

  it('says so when there is no page to focus', async () => {
    stub(page, vi.fn().mockResolvedValue({ ok: true, data: false }))
    render(<AgentBrowserPanel visible={true} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Type in the page' }))
    expect((await screen.findByRole('alert')).textContent).toContain('No page to focus')
  })

  it('is absent with no page, while the agent drives, and in the pop-out', async () => {
    stub({ ...page, open: false, tabs: [], url: '' })
    render(<AgentBrowserPanel visible={true} />)
    await screen.findByLabelText('Search or enter URL')
    expect(screen.queryByRole('button', { name: 'Type in the page' })).toBeNull()
    cleanup()

    stub({ ...page, agentBusy: true })
    render(<AgentBrowserPanel visible={true} />)
    await screen.findByText('Take control')
    expect(screen.queryByRole('button', { name: 'Type in the page' })).toBeNull()
    cleanup()

    stub({ ...page, pip: true })
    render(<AgentBrowserPanel visible={true} />)
    await screen.findByLabelText('More actions')
    await waitFor(() => expect(document.querySelector('[data-browser-address]')).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'Type in the page' })).toBeNull()
  })

  it('stays once the person has taken control', async () => {
    stub({ ...page, agentBusy: true, userControl: true })
    render(<AgentBrowserPanel visible={true} />)
    expect(await screen.findByRole('button', { name: 'Type in the page' })).toBeTruthy()
  })
})

describe('splitBrowserUrl', () => {
  it('splits an address into its host and the rest', () => {
    expect(splitBrowserUrl('https://github.com/vyotiq/agent-v?tab=readme#top')).toEqual({
      host: 'github.com',
      rest: '/vyotiq/agent-v?tab=readme#top'
    })
    expect(splitBrowserUrl('http://localhost:4321/')).toEqual({ host: 'localhost:4321', rest: '' })
    expect(splitBrowserUrl('about:blank')).toBeNull()
    expect(splitBrowserUrl('')).toBeNull()
  })
})
