/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatSideRail } from '@renderer/features/chat/components/ChatSideRail'
import { DOCK_PANELS, PANEL_SHORTCUT } from '@renderer/lib/utils/dockPanels'
import { shortcutAriaKeys } from '@renderer/lib/shortcuts'

const readRunArtifact = vi.fn()

beforeEach(() => {
  readRunArtifact.mockReset()
  readRunArtifact.mockResolvedValue({ ok: false, error: 'none' })
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: { readRunArtifact, platform: 'win32' }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderRail(props: Partial<Parameters<typeof ChatSideRail>[0]> = {}) {
  return render(
    <ChatSideRail
      activePanel={null}
      onSelectPanel={vi.fn()}
      workspacePath={null}
      runId={null}
      {...props}
    />
  )
}

/** Buttons in rail order — the strip is one toolbar, not seven tab stops. */
function railButtons(): HTMLButtonElement[] {
  const strip = document.querySelector('[role="toolbar"]')
  return Array.from(strip?.querySelectorAll('button') ?? [])
}

describe('ChatSideRail chrome', () => {
  it('offers every dock panel with the chord that actually toggles it', () => {
    renderRail()
    for (const panel of DOCK_PANELS) {
      const button = screen.getByRole('button', { name: new RegExp(panel.showLabel, 'i') })
      expect(button.getAttribute('aria-keyshortcuts')).toBe(
        shortcutAriaKeys(PANEL_SHORTCUT[panel.id])
      )
    }
  })

  it('marks the open panel pressed and labels it as a hide', () => {
    renderRail({ activePanel: 'terminal' })
    const button = screen.getByRole('button', { name: /Hide terminal panel/i })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(
      screen.getByRole('button', { name: /Show files panel/i }).getAttribute('aria-pressed')
    ).toBe('false')
  })

  it('goes quiet for the panel that is already open', () => {
    renderRail({
      activePanel: 'terminal',
      panelState: { terminal: { active: true, detail: 'Running pnpm test' } }
    })
    expect(document.querySelector('[data-rail-row="terminal"][data-rail-active]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Hide terminal panel' })).toBeTruthy()
  })
})

describe('ChatSideRail live markers', () => {
  it('pulses the panel the run is working in and names what it is doing', () => {
    renderRail({
      running: true,
      panelState: { files: { active: true, detail: 'Editing src/app.ts' } }
    })
    const row = document.querySelector('[data-rail-row="files"]')
    expect(row?.getAttribute('data-rail-active')).toBe('1')
    expect(row?.querySelector('.animate-ping')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /Show files panel · Editing src\/app\.ts/i })
    ).toBeTruthy()
  })

  it('counts what is waiting for the reader', () => {
    renderRail({ panelState: { changes: { count: 3, detail: '3 files to review' } } })
    const row = document.querySelector('[data-rail-row="changes"]')
    expect(row?.querySelector('[data-rail-count]')?.textContent).toBe('3')
    expect(row?.getAttribute('data-rail-active')).toBeNull()
    expect(
      screen.getByRole('button', { name: /Show changes panel · 3 files to review/i })
    ).toBeTruthy()
  })

  it('caps the count so the badge never outgrows the button', () => {
    renderRail({ panelState: { changes: { count: 42 } } })
    expect(
      document.querySelector('[data-rail-row="changes"] [data-rail-count]')?.textContent
    ).toBe('9+')
  })

  it('shows one marker at a time — activity outranks a queue', () => {
    renderRail({ panelState: { changes: { active: true, count: 3 } } })
    const row = document.querySelector('[data-rail-row="changes"]')
    expect(row?.querySelector('.animate-ping')).toBeTruthy()
    expect(row?.querySelector('[data-rail-count]')).toBeNull()
  })

  it('leaves panels with no live state unmarked', () => {
    renderRail({ panelState: { files: { active: true } } })
    // Pull request state needs a network round trip, so the rail claims none.
    const pr = document.querySelector('[data-rail-row="pr"]')
    expect(pr?.querySelector('.animate-ping')).toBeNull()
    expect(pr?.querySelector('[data-rail-count]')).toBeNull()
    expect(document.querySelectorAll('[data-rail-active]')).toHaveLength(1)
  })
})

describe('ChatSideRail keyboard', () => {
  it('is one tab stop that the arrows walk', async () => {
    renderRail({ onExpandPanels: vi.fn() })
    const buttons = railButtons()
    expect(buttons).toHaveLength(DOCK_PANELS.length + 1)
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1)
    expect(buttons[0]!.tabIndex).toBe(0)

    buttons[0]!.focus()
    fireEvent.keyDown(buttons[0]!, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(railButtons()[1]))
    expect(railButtons()[1]!.tabIndex).toBe(0)
    expect(railButtons()[0]!.tabIndex).toBe(-1)

    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    await waitFor(() =>
      expect(document.activeElement).toBe(railButtons()[DOCK_PANELS.length])
    )

    // Wraps rather than trapping focus at the end of the strip.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(railButtons()[0]))

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    await waitFor(() =>
      expect(document.activeElement).toBe(railButtons()[DOCK_PANELS.length])
    )
  })

  it('keeps a tab stop when the Expand button that held it goes away', async () => {
    const { rerender } = render(
      <ChatSideRail
        activePanel={null}
        onSelectPanel={vi.fn()}
        workspacePath={null}
        runId={null}
        onExpandPanels={vi.fn()}
      />
    )
    fireEvent.keyDown(railButtons()[0]!, { key: 'End' })
    await waitFor(() => expect(railButtons()[DOCK_PANELS.length]!.tabIndex).toBe(0))

    rerender(
      <ChatSideRail activePanel={null} onSelectPanel={vi.fn()} workspacePath={null} runId={null} />
    )
    expect(railButtons()).toHaveLength(DOCK_PANELS.length)
    expect(railButtons().filter((b) => b.tabIndex === 0)).toHaveLength(1)
  })

  it('exposes the strip as a vertical toolbar', () => {
    renderRail()
    const strip = document.querySelector('[role="toolbar"]')
    expect(strip?.getAttribute('aria-orientation')).toBe('vertical')
    expect(strip?.getAttribute('aria-label')).toBe('Panels')
  })
})
