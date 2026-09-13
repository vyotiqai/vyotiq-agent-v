/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sidebar } from '@renderer/app/sidebar'
import { createRef } from 'react'
import {
  resetDockImmersiveStore,
  setDockImmersive
} from '@renderer/lib/hooks/dockImmersiveStore'
import {
  resetWorkspaceHotUiStoreForTests,
  setWorkspaceHotUi
} from '@renderer/lib/hooks/workspaceHotUiStore'

const searchRef = createRef<HTMLInputElement>()

const baseProps = {
  view: 'chat' as const,
  sessionQuery: '',
  searchRef,
  hasWorkspace: true,
  openPaths: ['/ws/demo'],
  activePath: '/ws/demo',
  runsByWorkspacePath: {
    '/ws/demo': {
      runs: [],
      runsCapped: false,
      runsError: null,
      runsLoaded: true,
      activeRunId: null
    }
  },
  activeRuns: [],
  onSessionQuery: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenMarketplace: vi.fn(),
  onOpenChat: vi.fn(),
  onOpenHome: vi.fn(),
  onSelectRunInWorkspace: vi.fn(),
  onRenameRunInWorkspace: vi.fn(),
  onDeleteRunInWorkspace: vi.fn(),
  onCloseDrawer: vi.fn(),
  onToggleSidebar: vi.fn(),
  onSwitchWorkspace: vi.fn(),
  onCloseWorkspace: vi.fn(),
  onAddWorkspace: vi.fn(),
  workspaceHasBackgroundRun: () => false
}

beforeEach(() => {
  // @ts-expect-error test bridge
  window.vyotiq = { platform: 'win32' }
  resetDockImmersiveStore()
  resetWorkspaceHotUiStoreForTests()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetDockImmersiveStore()
  resetWorkspaceHotUiStoreForTests()
})

describe('Sidebar chrome', () => {
  it('disables search when no workspace is open', () => {
    render(
      <Sidebar
        {...baseProps}
        hasWorkspace={false}
        openPaths={[]}
        activePath={null}
        runsByWorkspacePath={{}}
      />
    )

    expect((screen.getByRole('textbox', { name: /search chats/i }) as HTMLInputElement).disabled).toBe(
      true
    )
    expect((screen.getByRole('button', { name: /^settings$/i }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  it('highlights the active footer nav item', () => {
    const { rerender } = render(<Sidebar {...baseProps} view="chat" />)

    expect(screen.getByRole('button', { name: /^settings$/i }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('button', { name: /^marketplace$/i }).getAttribute('aria-current')).toBeNull()

    rerender(<Sidebar {...baseProps} view="settings" />)
    expect(screen.getByRole('button', { name: /^settings$/i }).getAttribute('aria-current')).toBe(
      'page'
    )

    rerender(<Sidebar {...baseProps} view="marketplace" />)
    expect(screen.getByRole('button', { name: /^marketplace$/i }).getAttribute('aria-current')).toBe(
      'page'
    )
  })

  it('calls onOpenHome from the header button', () => {
    const onOpenHome = vi.fn()
    render(<Sidebar {...baseProps} onOpenHome={onOpenHome} />)

    fireEvent.click(screen.getByRole('button', { name: /^home$/i }))
    expect(onOpenHome).toHaveBeenCalledTimes(1)
  })

  it('calls onOpenHome from the collapsed header button', () => {
    const onOpenHome = vi.fn()
    render(<Sidebar {...baseProps} collapsed onOpenHome={onOpenHome} />)

    fireEvent.click(screen.getByRole('button', { name: /^home$/i }))
    expect(onOpenHome).toHaveBeenCalledTimes(1)
  })

  it('calls onOpenSettings from the footer', () => {
    const onOpenSettings = vi.fn()
    render(<Sidebar {...baseProps} onOpenSettings={onOpenSettings} />)

    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('keeps the brand mark in the collapsed header with a hover toggle', () => {
    const { container } = render(<Sidebar {...baseProps} collapsed />)

    expect(container.querySelector('[data-collapsed]')).toBeTruthy()
    expect(container.querySelector('[data-sidebar-brand-toggle] [data-brand-mark]')).toBeTruthy()
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /home/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^settings$/i })).toBeTruthy()
  })

  it('uses a flat bg-bg shell without footer tray chrome', () => {
    const { container } = render(<Sidebar {...baseProps} />)

    const aside = container.querySelector('aside')
    expect(aside).toBeTruthy()
    expect(aside!.className).toContain('bg-transparent')
    expect(aside!.className).not.toContain('bg-card')

    const footer = screen.getByRole('button', { name: /^settings$/i }).parentElement
    expect(footer).toBeTruthy()
    expect(footer!.className).toContain('border-t')
    expect(footer!.className).toContain('border-border/30')
    expect(footer!.className).not.toContain('rounded-xl')
  })

  it('uses a flat search field without pill chrome', () => {
    render(<Sidebar {...baseProps} />)

    const input = screen.getByRole('textbox', { name: /search chats/i })
    const wrapper = input.parentElement
    expect(wrapper).toBeTruthy()
    expect(wrapper!.className).toContain('bg-transparent')
    expect(wrapper!.className).not.toContain('rounded-full')
    expect(wrapper!.className).not.toContain('border-border')
  })

  it('shows a notifications bell above Settings', () => {
    render(<Sidebar {...baseProps} />)
    expect(screen.getByRole('button', { name: /^notifications$/i })).toBeTruthy()
    const settings = screen.getByRole('button', { name: /^settings$/i })
    const footer = settings.parentElement
    expect(footer?.textContent).toMatch(/Notifications/i)
  })

  it('keeps session search while dock is immersive and hides chat rows until you search', () => {
    const props = {
      ...baseProps,
      runsByWorkspacePath: {
        '/ws/demo': {
          runs: [
            {
              runId: 'run-1',
              goal: 'Hidden in immersive',
              status: 'done' as const,
              updatedAt: new Date().toISOString()
            }
          ],
          runsCapped: false,
          runsError: null,
          runsLoaded: true,
          activeRunId: 'run-1'
        }
      }
    }
    const { rerender } = render(<Sidebar {...props} />)
    expect(screen.getByRole('textbox', { name: /search chats/i })).toBeTruthy()
    expect(screen.getByText('Hidden in immersive')).toBeTruthy()

    setDockImmersive(true)
    rerender(<Sidebar {...props} />)
    expect(screen.getByRole('textbox', { name: /search chats/i })).toBeTruthy()
    expect(screen.queryByText('Hidden in immersive')).toBeNull()
    expect(screen.getByText('Workspaces')).toBeTruthy()
    expect(screen.getByRole('button', { name: /home/i })).toBeTruthy()

    setWorkspaceHotUi('/ws/demo', { sessionQuery: 'Hidden' })
    rerender(<Sidebar {...props} />)
    expect(screen.getByText('Hidden in immersive')).toBeTruthy()

    setDockImmersive(false)
    rerender(<Sidebar {...props} />)
    expect(screen.getByRole('textbox', { name: /search chats/i })).toBeTruthy()
    expect(screen.getByText('Hidden in immersive')).toBeTruthy()
  })

  it('collapses the drawer to the rail when hideSessions is set (Home mode)', () => {
    render(
      <Sidebar
        {...baseProps}
        variant="drawer"
        hideSessions
        runsByWorkspacePath={{
          '/ws/demo': {
            runs: [
              {
                runId: 'run-1',
                status: 'done',
                updatedAt: new Date().toISOString(),
                goal: 'Drawer run'
              }
            ],
            runsCapped: false,
            runsError: null,
            runsLoaded: true,
            activeRunId: null
          }
        }}
      />
    )

    expect(
      document.querySelector('[data-sidebar-shell]')?.getAttribute('data-collapsed')
    ).toBe('true')
    expect(screen.queryByRole('button', { name: /Drawer run/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy()
  })
})
