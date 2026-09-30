/**
 * @vitest-environment jsdom
 *
 * Both composer popovers open against a full-width composer anchor, so the one
 * layout rule that has to hold at every size is: the panel stays inside the
 * viewport, and the pinned footer never rides over the rows. jsdom has no
 * layout, so these assert the inline geometry the panels actually compute
 * (left/width/max-height from clampComposerDropdownPanel) plus the structure
 * that keeps the footer out of the scrolling region.
 */
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SlashCommandDescriptor } from '@shared/ipc'
import { SlashCommandMenu } from '@renderer/features/chat/components/composer/SlashCommandMenu'
import { MentionMenu } from '@renderer/features/chat/components/composer/MentionMenu'
import type { MentionMenuItem } from '@renderer/features/chat/components/composer/mentionModel'
import { COMPOSER_DROPDOWN_PAD_PX } from '@renderer/features/chat/components/composer/composerDropdownLayout'

/** The widths the run contract names. */
const VIEWPORTS = [800, 1600]

const commands: SlashCommandDescriptor[] = [
  {
    id: 'skill:write-tests',
    trigger: 'write-tests',
    label: 'Write tests',
    description: 'Cover a change with focused tests. Reads the diff first',
    kind: 'skill',
    group: 'Skills',
    availability: 'ready',
    packageId: 'write-tests'
  },
  {
    id: 'builtin:goal',
    trigger: 'goal',
    label: 'Set goal',
    description: 'Keep working toward an objective',
    kind: 'builtin',
    group: 'App',
    availability: 'ready'
  }
]

const mentionItems: MentionMenuItem[] = [
  {
    id: 'file:src/renderer/src/features/chat/components/composer/MentionMenu.tsx',
    kind: 'file',
    path: 'src/renderer/src/features/chat/components/composer/MentionMenu.tsx',
    label: 'MentionMenu.tsx',
    subtitle: 'src/renderer/src/features/chat/components/composer'
  },
  {
    id: 'folder:src/renderer/src/features/chat/components/composer',
    kind: 'folder',
    path: 'src/renderer/src/features/chat/components/composer',
    label: 'composer',
    subtitle: 'src/renderer/src/features/chat/components'
  },
  { id: 'files', kind: 'nav', view: 'files', label: 'Files and folders' }
]

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

/**
 * A composer anchor that fills its pane, anchored at the pane's right edge —
 * the position with the least room between the anchor and the viewport border.
 */
function createAnchor(anchorRef: { current: HTMLElement | null }, viewportWidth: number): void {
  const anchor = document.createElement('div')
  document.body.appendChild(anchor)
  const width = viewportWidth - 64
  anchor.getBoundingClientRect = () =>
    ({
      top: 400,
      bottom: 460,
      left: viewportWidth - 64,
      right: viewportWidth - 64 + width,
      width,
      height: 60
    }) as DOMRect
  anchorRef.current = anchor
}

function renderSlash(anchorRef: { current: HTMLElement | null }): void {
  render(
    <SlashCommandMenu
      open
      commands={commands}
      activeIndex={0}
      onActiveIndexChange={() => {}}
      onPick={() => {}}
      anchorRef={anchorRef as never}
    />
  )
}

function renderMention(anchorRef: { current: HTMLElement | null }): void {
  render(
    <MentionMenu
      open
      view="root"
      items={mentionItems}
      activeIndex={0}
      onActiveIndexChange={() => {}}
      onPick={() => {}}
      anchorRef={anchorRef as never}
    />
  )
}

/** Parse an inline `NNNpx` style value written by the panel. */
function px(value: string): number {
  return Number.parseFloat(value)
}

type MenuCase = {
  render: (anchorRef: { current: HTMLElement | null }) => void
  listLabel: string
  footerSelector: string
  /**
   * The element carrying the panel's left/width/max-height. The two menus
   * differ on purpose: the slash panel wraps its listbox, while the mention
   * panel is the listbox itself. Assert against each one's real structure.
   */
  panelOf: (listbox: HTMLElement) => HTMLElement
  /**
   * The region that scrolls — what the footer has to stay out of. The slash
   * listbox scrolls itself; the mention panel wraps a scrolling div.
   */
  scrollRegionOf: (listbox: HTMLElement) => HTMLElement
}

const MENUS: Record<string, MenuCase> = {
  slash: {
    render: renderSlash,
    listLabel: 'Slash commands',
    footerSelector: '[data-slash-footer]',
    panelOf: (listbox) => listbox.closest('[data-slash-panel]') as HTMLElement,
    scrollRegionOf: (listbox) => listbox
  },
  mention: {
    render: renderMention,
    listLabel: 'Mentions',
    footerSelector: '[data-mention-footer]',
    panelOf: (listbox) => listbox,
    scrollRegionOf: (listbox) => listbox.querySelector('.scroll-thin') as HTMLElement
  }
}

describe.each(Object.entries(MENUS))('%s menu viewport containment', (_name, menu) => {
  beforeEach(() => {
    setViewportWidth(1024)
  })

  afterEach(() => {
    cleanup()
  })

  it.each(VIEWPORTS)('stays inside the viewport at %ipx, list plus footer', (viewportWidth) => {
    setViewportWidth(viewportWidth)
    const anchorRef = createRef<HTMLElement>()
    createAnchor(anchorRef, viewportWidth)
    menu.render(anchorRef)

    const listbox = screen.getByRole('listbox', { name: menu.listLabel })
    const panel = menu.panelOf(listbox)
    const pad = COMPOSER_DROPDOWN_PAD_PX

    const left = px(panel.style.left)
    const width = px(panel.style.width)

    // Inside the viewport on both edges, with the pad respected.
    expect(left).toBeGreaterThanOrEqual(pad)
    expect(left + width).toBeLessThanOrEqual(viewportWidth - pad)
    expect(px(panel.style.maxWidth)).toBe(width)
    expect(px(panel.style.maxHeight)).toBeGreaterThan(0)

    // A full-width composer does not stretch the panel: it stops at its own
    // bound, so a 1600px pane reads the same as an 800px one.
    expect(width).toBeLessThanOrEqual(viewportWidth - pad * 2)

    // The list yields the height; the footer is pinned outside it, so the two
    // can never overlap.
    const footer = panel.querySelector(menu.footerSelector) as HTMLElement
    expect(footer).not.toBeNull()
    const scrollRegion = menu.scrollRegionOf(listbox)
    expect(scrollRegion).not.toBeNull()
    expect(scrollRegion.contains(footer)).toBe(false)
    expect(scrollRegion.classList.contains('min-h-0')).toBe(true)
    expect(scrollRegion.classList.contains('overflow-y-auto')).toBe(true)
    expect(footer.classList.contains('shrink-0')).toBe(true)
  })
})
