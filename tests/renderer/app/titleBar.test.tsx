/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TitleBar } from '@renderer/app/TitleBar'
import { MACOS_TITLEBAR_INSET_PX } from '@shared/windowChrome'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderBar(
  platform: string | undefined,
  options: { navigatorOpen?: boolean; width?: number; compact?: boolean } = {}
) {
  const onToggleNavigator = vi.fn()
  const onOpenSearch = vi.fn()
  window.vyotiq = {
    platform,
    windowIsMaximized: vi.fn(async () => ({ ok: true as const, data: false })),
    windowMinimize: vi.fn(),
    windowMaximize: vi.fn(),
    windowClose: vi.fn()
  } as unknown as typeof window.vyotiq
  const utils = render(
    <TitleBar
      navigatorOpen={options.navigatorOpen ?? true}
      navigatorWidthPx={options.width ?? 264}
      onToggleNavigator={onToggleNavigator}
      onOpenSearch={onOpenSearch}
      compact={options.compact}
    />
  )
  return { ...utils, onToggleNavigator, onOpenSearch }
}

describe('TitleBar', () => {
  it('draws the three caption buttons on win32, each 46px wide', () => {
    renderBar('win32')
    for (const name of [/minimize/i, /maximize/i, /^close$/i]) {
      expect(screen.getByRole('button', { name }).style.width).toBe('46px')
    }
  })

  it('draws no caption buttons on macOS and clears the traffic lights', () => {
    const { container } = renderBar('darwin')
    expect(screen.queryByRole('button', { name: /minimize/i })).toBeNull()
    const brand = container.querySelector('[data-titlebar-brand]') as HTMLElement
    expect(brand.style.paddingLeft).toBe(`${MACOS_TITLEBAR_INSET_PX}px`)
  })

  it('lines the mark and toggle up over the navigator column', () => {
    const { container } = renderBar('win32', { width: 300 })
    const brand = container.querySelector('[data-titlebar-brand]') as HTMLElement
    expect(brand.style.width).toBe('300px')
    expect(brand.textContent).toContain('Agent V')
  })

  it('names the toggle by what it will do, with its shortcut', () => {
    const { onToggleNavigator, rerender } = renderBar('win32', { navigatorOpen: true })
    fireEvent.click(screen.getByRole('button', { name: /hide navigator \(Ctrl\+B\)/i }))
    expect(onToggleNavigator).toHaveBeenCalled()
    rerender(
      <TitleBar navigatorOpen={false} navigatorWidthPx={264} onToggleNavigator={vi.fn()} onOpenSearch={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: /show navigator/i })).toBeTruthy()
  })

  it('opens search from the centred trigger and shows its shortcut as keycaps', () => {
    const { onOpenSearch } = renderBar('win32')
    const trigger = screen.getByRole('button', { name: /search tasks, files and commands/i })
    expect([...trigger.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'K'])
    fireEvent.click(trigger)
    expect(onOpenSearch).toHaveBeenCalled()
  })

  it('is a drag region whose controls all opt out', () => {
    renderBar('win32')
    const header = screen.getByRole('banner')
    expect(header.className).toContain('app-region-drag')
    for (const button of screen.getAllByRole('button')) {
      expect(button.closest('.app-region-no-drag')).not.toBeNull()
    }
  })

  it('gives Close its own hover colour instead of stacking two', () => {
    renderBar('win32')
    const close = screen.getByRole('button', { name: /^close$/i })
    expect(close.className).toContain('hover:bg-window-close')
    expect(close.className).not.toContain('hover:bg-surface')
  })
})
