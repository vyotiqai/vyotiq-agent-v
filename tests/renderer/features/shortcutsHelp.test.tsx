/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ShortcutsHelpDialog, isHelpKey } from '@renderer/features/help/ShortcutsHelpDialog'
import { documentationUrl, openDocumentationUrl, requestShortcutsHelp } from '@renderer/features/help/helpRequests'
import { paletteCommands, runPaletteCommand } from '@renderer/features/commandPalette/paletteCommands'
import { applyShortcutOverrides, findShortcutConflict, notifyShortcutListeners } from '@renderer/lib/shortcuts'
import { SHORTCUT_BINDINGS } from '@renderer/lib/shortcuts/bindings'
import { resetShortcutRegistryForTests } from '@renderer/lib/shortcuts/registry'

afterEach(() => {
  cleanup()
  resetShortcutRegistryForTests()
  // @ts-expect-error test cleanup
  delete window.vyotiq
})

function dialog() {
  return screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })
}

describe('ShortcutsHelpDialog', () => {
  it('opens on ? outside a text field, and not while typing', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'win32' }
    render(
      <>
        <input aria-label="field" />
        <ShortcutsHelpDialog />
      </>
    )
    fireEvent.keyDown(screen.getByLabelText('field'), { key: '?', shiftKey: true })
    expect(dialog()).toBeNull()
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
    expect(dialog()).not.toBeNull()
  })

  it('opens on Ctrl+/ and from a request, grouped by area with the chords as keycaps', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'win32' }
    render(<ShortcutsHelpDialog />)
    fireEvent.keyDown(document.body, { key: '/', ctrlKey: true })
    const open = dialog()
    expect(open).not.toBeNull()
    for (const area of ['Go', 'Task', 'Inspector', 'Panels', 'Text size']) {
      expect(within(open!).getByRole('region', { name: area })).toBeTruthy()
    }
    const row = open!.querySelector('[data-shortcut-row="search"]')!
    expect([...row.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'K'])
    fireEvent.click(within(open!).getByRole('button', { name: 'Close' }))
    expect(dialog()).toBeNull()
    act(() => {
      expect(requestShortcutsHelp()).toBe(true)
    })
    expect(dialog()).not.toBeNull()
  })

  it('shows a rebound chord with its new keys', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'win32' }
    render(<ShortcutsHelpDialog />)
    act(() => {
      requestShortcutsHelp()
    })
    act(() => {
      applyShortcutOverrides({ newChat: { key: 'y', mod: true, shift: 'require' } })
      notifyShortcutListeners()
    })
    const row = dialog()!.querySelector('[data-shortcut-row="newChat"]')!
    expect([...row.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'Shift', 'Y'])
    expect(row.querySelector('.text-fg-strong')?.textContent).toBe('New task')
  })

  it('reads ? as the help key only without Ctrl, Cmd or Alt', () => {
    expect(isHelpKey({ key: '?', ctrlKey: false, metaKey: false, altKey: false })).toBe(true)
    expect(isHelpKey({ key: '?', ctrlKey: true, metaKey: false, altKey: false })).toBe(false)
    expect(isHelpKey({ key: '/', ctrlKey: false, metaKey: false, altKey: false })).toBe(false)
  })

  it('takes a chord no other built-in shortcut uses', () => {
    expect(findShortcutConflict('shortcutsHelp', SHORTCUT_BINDINGS.shortcutsHelp)).toBeNull()
  })
})

describe('help in the command palette', () => {
  it('lists Keyboard shortcuts with its keys, and Open documentation', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'win32' }
    const commands = paletteCommands({ workspaces: [], activePath: null, canSendFeedback: false })
    expect(commands.find((c) => c.id === 'shortcutsHelp')).toMatchObject({ title: 'Show keyboard shortcuts', keys: ['Ctrl', '/'] })
    expect(commands.find((c) => c.id === 'openDocs')).toMatchObject({ title: 'Open documentation' })
  })

  it('opens the docs under the homepage main reports', async () => {
    const shellOpenExternal = vi.fn(async () => ({ ok: true as const, data: true as const }))
    window.vyotiq = {
      platform: 'win32',
      shellOpenExternal,
      getAppInfo: async () => ({ ok: true, data: { homepage: 'https://vyotiq.com' } })
    } as unknown as typeof window.vyotiq
    expect(await openDocumentationUrl()).toBeNull()
    expect(shellOpenExternal).toHaveBeenCalledWith('https://vyotiq.com/docs')
    expect(documentationUrl(null)).toBe('https://vyotiq.com/docs')
  })

  it('opens the shortcuts list from the palette command', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'win32' }
    render(<ShortcutsHelpDialog />)
    const noop = (): void => {}
    act(() => {
      runPaletteCommand('shortcutsHelp', {
        workspaces: [],
        onOpenSettings: noop,
        onOpenHome: noop,
        onOpenUsage: noop,
        onNewTask: noop,
        onToggleNavigator: noop,
        onNextNeedsYou: noop,
        onSwitchWorkspaceByIndex: noop,
        onFocusInstructionLine: noop,
        onOpenSettingsField: noop
      })
    })
    expect(dialog()).not.toBeNull()
  })
})
