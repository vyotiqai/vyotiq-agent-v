/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fitTabs } from '@renderer/features/inspector/tabOverflow'
import { Inspector } from '@renderer/features/inspector/Inspector'

const IDS = ['changes', 'files', 'terminal', 'browser', 'pr', 'plan'] as const
const WIDTH: Record<string, number> = { changes: 70, files: 40, terminal: 60, browser: 60, pr: 30, plan: 40 }
const widthOf = (id: string): number => WIDTH[id]!

describe('fitTabs', () => {
  it('keeps every tab when they all fit', () => {
    // 300 of tabs + 5 gaps of 8 = 340.
    expect(fitTabs({ ids: IDS, widthOf, available: 340, gap: 8, moreWidth: 24, active: 'changes' }).hidden).toEqual([])
  })

  it('moves the tabs past the room, keeping their order, behind the menu button', () => {
    // Budget 240 - 24 - 8 = 208: changes, files, terminal (186) fit; browser would make 254.
    const fit = fitTabs({ ids: IDS, widthOf, available: 240, gap: 8, moreWidth: 24, active: 'files' })
    expect(fit.visible).toEqual(['changes', 'files', 'terminal'])
    expect(fit.hidden).toEqual(['browser', 'pr', 'plan'])
  })

  it('always shows the current tab, in its own place', () => {
    const fit = fitTabs({ ids: IDS, widthOf, available: 240, gap: 8, moreWidth: 24, active: 'plan' })
    expect(fit.visible).toEqual(['changes', 'files', 'plan'])
    expect(fit.hidden).toEqual(['terminal', 'browser', 'pr'])
  })

  it('shows the current tab alone when nothing else fits', () => {
    const fit = fitTabs({ ids: IDS, widthOf, available: 60, gap: 8, moreWidth: 24, active: 'browser' })
    expect(fit.visible).toEqual(['browser'])
  })
})

describe('Inspector — narrow strip', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('puts the tabs that do not fit in a More panels menu, marked when one has work waiting', async () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      const id = this.getAttribute('aria-controls')?.replace('dock-panel-', '')
      return id ? (WIDTH[id] ?? 0) : 0
    })
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.querySelector('[role="tablist"]') ? 240 : 0
    })
    const onSelect = vi.fn()
    render(
      <Inspector
        tab="changes"
        onSelect={onSelect}
        state={{ pr: { count: 2 } }}
        expanded={false}
        onToggleExpanded={() => {}}
        onHide={() => {}}
        width={240}
      >
        <div />
      </Inspector>
    )
    await act(async () => {})
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['Changes', 'Files', 'Terminal'])
    const more = screen.getByRole('button', { name: /More panels: Browser, PR, Plan/ })
    expect(document.querySelector('[data-inspector-more] .bg-accent')).toBeTruthy()
    fireEvent.click(more)
    fireEvent.click(await screen.findByRole('menuitem', { name: /PR/ }))
    expect(onSelect).toHaveBeenCalledWith('pr')
  })

  it('has no menu when every tab fits', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    render(
      <Inspector tab="changes" onSelect={() => {}} state={{}} expanded={false} onToggleExpanded={() => {}} onHide={() => {}} width={480}>
        <div />
      </Inspector>
    )
    expect(screen.getAllByRole('tab')).toHaveLength(6)
    expect(screen.queryByRole('button', { name: /More panels/ })).toBeNull()
  })
})
