/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TitleBar } from '@renderer/app/TitleBar'
import { BreakpointProvider } from '@renderer/lib/context/BreakpointProvider'
import { MACOS_TITLEBAR_INSET_PX } from '@shared/windowChrome'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query.includes('1024px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderBar(
  platform: string | undefined,
  options: {
    drawerOpen?: boolean
    desktop?: boolean
    sidebarExpanded?: boolean
  } = {}
) {
  // @ts-expect-error test bridge
  window.vyotiq = {
    platform,
    windowIsMaximized: vi.fn(async () => ({ ok: true as const, data: false }))
  }

  if (options.desktop === false) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({
        matches: false,
        media: '',
        addEventListener: () => {},
        removeEventListener: () => {}
      })
    })
  }

  return render(
    <BreakpointProvider>
      <TitleBar
        drawerOpen={options.drawerOpen ?? false}
        onToggleSidebar={vi.fn()}
        sidebarExpanded={options.sidebarExpanded ?? false}
      />
    </BreakpointProvider>
  )
}

describe('TitleBar', () => {
  it('shows window controls on win32', () => {
    renderBar('win32')
    expect(screen.getByRole('button', { name: /minimize/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /maximize/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Close$/ })).toBeTruthy()
  })

  it('does not host the desktop sidebar toggle', () => {
    renderBar('win32')
    expect(screen.queryByRole('button', { name: /collapse sidebar/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /expand sidebar/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /open menu/i })).toBeNull()
  })

  it('shows the menu toggle on mobile', () => {
    renderBar('win32', { desktop: false })
    expect(screen.getByRole('button', { name: /open menu/i })).toBeTruthy()
  })

  it('does not render a brand mark in the mobile title bar', () => {
    const { container } = renderBar('win32', { desktop: false })
    expect(container.querySelector('[data-titlebar-accessory] [data-brand-mark]')).toBeNull()
  })

  it('does not render a brand mark in the desktop title bar', () => {
    const { container } = renderBar('win32')
    expect(container.querySelector('[data-titlebar-accessory] [data-brand-mark]')).toBeNull()
  })

  it('keeps the title bar brand-free while the sidebar is expanded', () => {
    const { container } = renderBar('win32', { sidebarExpanded: true })
    expect(container.querySelector('[data-titlebar-accessory] [data-brand-mark]')).toBeNull()
  })

  it('uses shared macOS inset on mobile title bar', () => {
    renderBar('darwin', { desktop: false })
    const header = screen.getByRole('banner')
    expect(header.style.paddingLeft).toBe(`${MACOS_TITLEBAR_INSET_PX}px`)
  })

  it('floats flush to the top edge as an overlay with no seam', () => {
    const { container } = renderBar('win32')
    const header = screen.getByRole('banner')
    expect(header.className).toContain('absolute')
    expect(header.className).toContain('inset-x-0')
    expect(header.className).toContain('top-0')
    expect(header.className).not.toContain('border-b')
    expect(container.querySelector('[data-titlebar-accessory]')).toBeTruthy()
  })
})
