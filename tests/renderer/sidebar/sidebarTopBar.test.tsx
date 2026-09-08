/**

 * @vitest-environment jsdom

 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cleanup, render, screen } from '@testing-library/react'

import { createRef } from 'react'

import { SidebarTopBar } from '@renderer/app/sidebar/SidebarTopBar'

import { SIDEBAR_SEARCH_ROW, SIDEBAR_TOOLBAR_ROW } from '@renderer/lib/utils/layout'



const searchRef = createRef<HTMLInputElement>()



beforeEach(() => {

  // @ts-expect-error test bridge

  window.vyotiq = { platform: 'win32' }

})



afterEach(() => {

  cleanup()

  vi.restoreAllMocks()

})



describe('SidebarTopBar layout', () => {

  it('uses an h-9 toolbar row aligned with the main title bar', () => {

    const { container } = render(

      <SidebarTopBar

        isDrawer={false}

        isDarwin={false}

        workspaceReady

        searchRef={searchRef}

        sessionQuery=""

        onToggleSidebar={vi.fn()}

        onSessionQuery={vi.fn()}

        onOpenHome={vi.fn()}

      />

    )



    const header = container.querySelector('header')

    expect(header).toBeTruthy()

    expect(header!.className).not.toContain('border-b')

    expect(header!.className).not.toContain('border-border/30')

    expect(container.querySelector('[data-sidebar-titlebar-strip]')).toBeNull()



    const toolbar = header!.firstElementChild as HTMLElement

    for (const token of SIDEBAR_TOOLBAR_ROW.split(/\s+/)) {

      expect(toolbar.className).toContain(token)

    }

    expect(toolbar.querySelector('[data-sidebar-brand-toggle] [data-brand-mark]')).toBeTruthy()
    expect(screen.getByRole('button', { name: /collapse sidebar/i })).toBeTruthy()

  })



  it('uses compact toolbar padding in drawer mode', () => {

    const { container } = render(

      <SidebarTopBar

        isDrawer

        isDarwin={false}

        workspaceReady

        searchRef={searchRef}

        sessionQuery=""

        onToggleSidebar={vi.fn()}

        onSessionQuery={vi.fn()}

        onOpenHome={vi.fn()}

      />

    )



    const toolbar = container.querySelector('header')?.firstElementChild as HTMLElement

    expect(toolbar.className).toContain('py-1.5')

    expect(toolbar.className).not.toContain('h-9')

  })



  it('places home in the toolbar row and uses a flat search field', () => {

    const { container } = render(

      <SidebarTopBar

        isDrawer={false}

        isDarwin={false}

        workspaceReady

        searchRef={searchRef}

        sessionQuery=""

        onToggleSidebar={vi.fn()}

        onSessionQuery={vi.fn()}

        onOpenHome={vi.fn()}

      />

    )



    expect(screen.getByRole('button', { name: /home/i })).toBeTruthy()



    const searchWrap = container.querySelector('header')?.lastElementChild as HTMLElement

    for (const token of SIDEBAR_SEARCH_ROW.split(/\s+/)) {

      expect(searchWrap.className).toContain(token)

    }



    const input = screen.getByRole('textbox', { name: /search chats/i })

    const wrapper = input.parentElement

    expect(wrapper).toBeTruthy()

    expect(wrapper!.className).toContain('h-8')

    expect(wrapper!.className).toContain('bg-transparent')

    expect(wrapper!.className).not.toContain('rounded-full')

    expect(wrapper!.className).not.toContain('border-border')

    expect(wrapper!.className).toContain('focus-within:vy-focus-ring')

  })

})


