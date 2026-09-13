/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SidebarBrandToggle } from '@renderer/app/sidebar/SidebarBrandToggle'

beforeEach(() => {
  // @ts-expect-error test bridge
  window.vyotiq = { platform: 'win32' }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SidebarBrandToggle', () => {
  it('shows the brand mark and a collapse control', () => {
    const { container } = render(
      <SidebarBrandToggle isDrawer={false} onToggleSidebar={vi.fn()} />
    )

    expect(container.querySelector('[data-brand-mark]')).toBeTruthy()
    expect(screen.getByRole('button', { name: /collapse sidebar/i })).toBeTruthy()
  })

  it('calls onToggleSidebar when the control is clicked', () => {
    const onToggleSidebar = vi.fn()
    render(<SidebarBrandToggle isDrawer={false} onToggleSidebar={onToggleSidebar} />)

    fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }))
    expect(onToggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('uses expand label when the sidebar is collapsed', () => {
    render(
      <SidebarBrandToggle isDrawer={false} isCollapsed onToggleSidebar={vi.fn()} />
    )

    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeTruthy()
  })
})
