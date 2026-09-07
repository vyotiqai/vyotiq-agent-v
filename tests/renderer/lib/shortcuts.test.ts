/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  extraShortcutCatalog,
  focusBrowserUrlIfOpen,
  focusComposerMessage,
  isMainComposerTarget,
  matchShortcut,
  shouldBlockAppShortcut,
  shouldBlockPanelShortcut,
  shouldDeferAppEscapeStop,
  shortcutCatalog,
  shortcutLabel,
  useAppShortcuts
} from '@renderer/lib/shortcuts'

afterEach(() => {
  document.body.innerHTML = ''
  // @ts-expect-error test cleanup
  delete window.vyotiq
})

function keyEvent(
  key: string,
  mods: {
    ctrlKey?: boolean
    metaKey?: boolean
    altKey?: boolean
    shiftKey?: boolean
  } = {}
): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, ...mods })
}

describe('matchShortcut', () => {
  it('matches mod chords with ctrl or meta and rejects alt/shift', () => {
    expect(matchShortcut(keyEvent('b', { ctrlKey: true }), 'sidebar')).toBe(true)
    expect(matchShortcut(keyEvent('B', { metaKey: true }), 'sidebar')).toBe(true)
    expect(matchShortcut(keyEvent('b', { ctrlKey: true, altKey: true }), 'sidebar')).toBe(
      false
    )
    expect(matchShortcut(keyEvent('b', { ctrlKey: true, shiftKey: true }), 'sidebar')).toBe(
      false
    )
    expect(matchShortcut(keyEvent('b'), 'sidebar')).toBe(false)
  })

  it('matches settings comma and plain Escape stop', () => {
    expect(matchShortcut(keyEvent(',', { ctrlKey: true }), 'settings')).toBe(true)
    expect(matchShortcut(keyEvent('Escape'), 'stop')).toBe(true)
    expect(matchShortcut(keyEvent('Escape', { ctrlKey: true }), 'stop')).toBe(false)
    expect(matchShortcut(keyEvent('Escape', { metaKey: true }), 'stop')).toBe(false)
    expect(matchShortcut(keyEvent('Escape', { altKey: true }), 'stop')).toBe(false)
  })

  it('matches panel find/refresh', () => {
    expect(matchShortcut(keyEvent('f', { ctrlKey: true }), 'find')).toBe(true)
    expect(matchShortcut(keyEvent('r', { metaKey: true }), 'refresh')).toBe(true)
    expect(matchShortcut(keyEvent('r', { ctrlKey: true, shiftKey: true }), 'refresh')).toBe(
      false
    )
  })

  it('matches dictation Ctrl/Cmd+M', () => {
    expect(matchShortcut(keyEvent('m', { ctrlKey: true }), 'dictation')).toBe(true)
    expect(matchShortcut(keyEvent('M', { metaKey: true }), 'dictation')).toBe(true)
    expect(matchShortcut(keyEvent('m', { ctrlKey: true, shiftKey: true }), 'dictation')).toBe(
      false
    )
  })

  it('matches mode cycle with optional shift and panel chords', () => {
    expect(matchShortcut(keyEvent('.', { ctrlKey: true }), 'cycleMode')).toBe(true)
    expect(matchShortcut(keyEvent('.', { ctrlKey: true, shiftKey: true }), 'cycleMode')).toBe(
      true
    )
    expect(matchShortcut(keyEvent('`', { ctrlKey: true }), 'panelTerminal')).toBe(true)
    expect(matchShortcut(keyEvent('e', { metaKey: true }), 'panelChanges')).toBe(true)
    expect(matchShortcut(keyEvent('b', { ctrlKey: true, shiftKey: true }), 'panelBrowser')).toBe(
      true
    )
    expect(matchShortcut(keyEvent('e', { ctrlKey: true, shiftKey: true }), 'panelFiles')).toBe(
      true
    )
    expect(matchShortcut(keyEvent('d', { ctrlKey: true, shiftKey: true }), 'panelPlan')).toBe(
      true
    )
    expect(matchShortcut(keyEvent('g', { ctrlKey: true, shiftKey: true }), 'panelPr')).toBe(true)
    expect(matchShortcut(keyEvent('e', { ctrlKey: true }), 'panelFiles')).toBe(false)
    expect(matchShortcut(keyEvent('w', { ctrlKey: true }), 'closeChat')).toBe(true)
    expect(matchShortcut(keyEvent('w', { ctrlKey: true, shiftKey: true }), 'closeChat')).toBe(
      false
    )
    expect(matchShortcut(keyEvent('b', { ctrlKey: true }), 'panelBrowser')).toBe(false)
    expect(matchShortcut(keyEvent('b', { ctrlKey: true, shiftKey: true }), 'sidebar')).toBe(false)
  })

  it('matches workspace switch chords Ctrl/Cmd+1..9', () => {
    expect(matchShortcut(keyEvent('1', { ctrlKey: true }), 'workspace1')).toBe(true)
    expect(matchShortcut(keyEvent('9', { metaKey: true }), 'workspace9')).toBe(true)
    expect(matchShortcut(keyEvent('1', { ctrlKey: true, altKey: true }), 'workspace1')).toBe(
      false
    )
    expect(matchShortcut(keyEvent('1', { ctrlKey: true, shiftKey: true }), 'workspace1')).toBe(
      false
    )
    expect(matchShortcut(keyEvent('1'), 'workspace1')).toBe(false)
  })
})

describe('shortcutLabel', () => {
  it('uses Ctrl+ on non-darwin', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'win32' }
    expect(shortcutLabel('search')).toBe('Ctrl+K')
    expect(shortcutLabel('newChat')).toBe('Ctrl+N')
    expect(shortcutLabel('settings')).toBe('Ctrl+,')
    expect(shortcutLabel('find')).toBe('Ctrl+F')
    expect(shortcutLabel('refresh')).toBe('Ctrl+R')
    expect(shortcutLabel('dictation')).toBe('Ctrl+M')
    expect(shortcutLabel('stop')).toBe('Esc')
    expect(shortcutLabel('cycleMode')).toBe('Ctrl+.')
    expect(shortcutLabel('panelTerminal')).toBe('Ctrl+`')
    expect(shortcutLabel('panelBrowser')).toBe('Ctrl+Shift+B')
    expect(shortcutLabel('panelFiles')).toBe('Ctrl+Shift+E')
    expect(shortcutLabel('panelPlan')).toBe('Ctrl+Shift+D')
    expect(shortcutLabel('panelPr')).toBe('Ctrl+Shift+G')
    expect(shortcutLabel('closeChat')).toBe('Ctrl+W')
    expect(shortcutLabel('workspace1')).toBe('Ctrl+1')
    expect(shortcutLabel('workspace9')).toBe('Ctrl+9')
    expect(shortcutCatalog().some((row) => row.id === 'search' && row.label === 'Ctrl+K')).toBe(
      true
    )
    expect(extraShortcutCatalog().some((row) => row.id === 'jump-latest' && row.label === 'End')).toBe(
      true
    )
    expect(extraShortcutCatalog().some((row) => row.id === 'jump-top' && row.label === 'Home')).toBe(
      true
    )
  })

  it('uses ⌘ on darwin', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'darwin' }
    expect(shortcutLabel('search')).toBe('⌘K')
    expect(shortcutLabel('focusComposer')).toBe('⌘L')
    expect(shortcutLabel('settings')).toBe('⌘,')
    expect(shortcutLabel('panelBrowser')).toBe('⌘⇧B')
  })
})

describe('shouldDeferAppEscapeStop', () => {
  it('defers for drawer, session query, menus, dialogs, and composer menus', () => {
    expect(shouldDeferAppEscapeStop({ drawerOpen: true })).toBe(true)
    expect(shouldDeferAppEscapeStop({ hasSessionQuery: true })).toBe(true)

    const menu = document.createElement('button')
    menu.setAttribute('aria-expanded', 'true')
    menu.setAttribute('aria-haspopup', 'menu')
    document.body.appendChild(menu)
    expect(shouldDeferAppEscapeStop()).toBe(true)
    menu.remove()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    expect(shouldDeferAppEscapeStop()).toBe(true)
    dialog.remove()

    const slash = document.createElement('div')
    slash.setAttribute('role', 'listbox')
    slash.setAttribute('aria-label', 'Slash commands')
    document.body.appendChild(slash)
    expect(shouldDeferAppEscapeStop()).toBe(true)
    slash.remove()
  })

  it('defers for sidebar inline confirm', () => {
    const confirm = document.createElement('div')
    confirm.setAttribute('data-inline-confirm', '')
    document.body.appendChild(confirm)
    expect(shouldDeferAppEscapeStop()).toBe(true)
  })

  it('defers for Mentions listbox', () => {
    const mentions = document.createElement('div')
    mentions.setAttribute('role', 'listbox')
    mentions.setAttribute('aria-label', 'Mentions')
    document.body.appendChild(mentions)
    expect(shouldDeferAppEscapeStop()).toBe(true)
  })

  it('defers when a dictation session strip is on screen', () => {
    const strip = document.createElement('div')
    strip.setAttribute('data-dictation-session', 'listening')
    document.body.appendChild(strip)
    expect(shouldDeferAppEscapeStop()).toBe(true)
  })

  it('defers when focus is inside inline cancel-edit composer', () => {
    const wrap = document.createElement('div')
    wrap.setAttribute('data-composer-inline', 'true')
    const input = document.createElement('div')
    input.tabIndex = 0
    wrap.appendChild(input)
    document.body.appendChild(wrap)
    input.focus()
    expect(document.activeElement).toBe(input)
    expect(shouldDeferAppEscapeStop()).toBe(true)
  })

  it('defers for focus-opened tooltip only', () => {
    const hoverTip = document.createElement('div')
    hoverTip.setAttribute('role', 'tooltip')
    hoverTip.setAttribute('data-opened-by', 'hover')
    hoverTip.textContent = 'Hover'
    document.body.appendChild(hoverTip)
    expect(shouldDeferAppEscapeStop()).toBe(false)
    hoverTip.remove()

    const focusTip = document.createElement('div')
    focusTip.setAttribute('role', 'tooltip')
    focusTip.setAttribute('data-opened-by', 'focus')
    focusTip.textContent = 'Focus'
    document.body.appendChild(focusTip)
    expect(shouldDeferAppEscapeStop()).toBe(true)
  })

  it('defers when find / PR title inputs are focused', () => {
    for (const label of ['Find in changes', 'Find in diff', 'PR title']) {
      const input = document.createElement('input')
      input.setAttribute('aria-label', label)
      document.body.appendChild(input)
      input.focus()
      expect(shouldDeferAppEscapeStop()).toBe(true)
      input.remove()
    }
  })

  it('does not defer when nothing is open', () => {
    expect(shouldDeferAppEscapeStop()).toBe(false)
  })

  it('defers when a tool approval gate is on screen', () => {
    const gate = document.createElement('div')
    gate.setAttribute('data-tool-approval', '')
    document.body.appendChild(gate)
    expect(shouldDeferAppEscapeStop()).toBe(true)
    gate.remove()
  })
})

describe('shouldBlockPanelShortcut', () => {
  it('allows the composer and xterm, blocks other inputs', () => {
    const composer = document.createElement('div')
    composer.setAttribute('role', 'textbox')
    composer.setAttribute('aria-label', 'Message')
    composer.contentEditable = 'true'
    document.body.appendChild(composer)
    expect(shouldBlockPanelShortcut(composer)).toBe(false)
    composer.remove()

    const xterm = document.createElement('textarea')
    xterm.className = 'xterm-helper-textarea'
    document.body.appendChild(xterm)
    expect(shouldBlockPanelShortcut(xterm)).toBe(false)
    xterm.remove()

    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(shouldBlockPanelShortcut(input)).toBe(true)
    input.remove()
  })
})

describe('shouldBlockAppShortcut', () => {
  it('allows the enabled composer when it renders as a combobox', () => {
    const composer = document.createElement('div')
    composer.setAttribute('role', 'combobox')
    composer.setAttribute('aria-label', 'Message')
    composer.contentEditable = 'true'
    document.body.appendChild(composer)
    expect(isMainComposerTarget(composer)).toBe(true)
    expect(shouldBlockAppShortcut(composer)).toBe(false)
    composer.remove()
  })

  it('blocks generic inputs and allows the main composer', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(shouldBlockAppShortcut(input)).toBe(true)
    input.remove()

    const composer = document.createElement('div')
    composer.setAttribute('role', 'textbox')
    composer.setAttribute('aria-label', 'Message')
    composer.contentEditable = 'true'
    document.body.appendChild(composer)
    expect(isMainComposerTarget(composer)).toBe(true)
    expect(shouldBlockAppShortcut(composer)).toBe(false)
    composer.remove()
  })
})

describe('focusComposerMessage', () => {
  it('focuses the enabled combobox composer and skips a disabled one', () => {
    const disabled = document.createElement('div')
    disabled.setAttribute('role', 'textbox')
    disabled.setAttribute('aria-label', 'Message')
    disabled.setAttribute('contenteditable', 'false')
    document.body.appendChild(disabled)

    const composer = document.createElement('div')
    composer.setAttribute('role', 'combobox')
    composer.setAttribute('aria-label', 'Message')
    composer.contentEditable = 'true'
    composer.tabIndex = 0
    document.body.appendChild(composer)

    expect(focusComposerMessage()).toBe(true)
    expect(document.activeElement).toBe(composer)
    composer.remove()
    disabled.remove()
  })

  it('focuses the Message textbox when present and editable', () => {
    const composer = document.createElement('div')
    composer.setAttribute('role', 'textbox')
    composer.setAttribute('aria-label', 'Message')
    composer.contentEditable = 'true'
    composer.tabIndex = 0
    document.body.appendChild(composer)
    expect(focusComposerMessage()).toBe(true)
    expect(document.activeElement).toBe(composer)
    composer.remove()
  })
})

describe('focusBrowserUrlIfOpen', () => {
  it('focuses a visible URL field and skips an inert dock', () => {
    const wrap = document.createElement('div')
    const input = document.createElement('input')
    input.setAttribute('data-browser-url', '')
    input.tabIndex = 0
    wrap.appendChild(input)
    document.body.appendChild(wrap)
    expect(focusBrowserUrlIfOpen()).toBe(true)
    expect(document.activeElement).toBe(input)

    wrap.setAttribute('inert', '')
    const other = document.createElement('div')
    other.tabIndex = 0
    document.body.appendChild(other)
    other.focus()
    expect(focusBrowserUrlIfOpen()).toBe(false)
    expect(document.activeElement).toBe(other)
    wrap.remove()
    other.remove()
  })
})

describe('useAppShortcuts escape stop', () => {
  function setup(onStop: ReturnType<typeof vi.fn>): void {
    renderHook(() =>
      useAppShortcuts({
        onToggleSidebar: () => {},
        onFocusSearch: () => {},
        onClearSearchFocus: () => {},
        isSearchFocused: () => false,
        onNewChat: () => {},
        onOpenSettings: () => {},
        chatViewActive: true,
        running: true,
        onStop
      })
    )
  }

  it('stops from plain focus but ignores Escape typed into an editable target', () => {
    const onStop = vi.fn()
    setup(onStop)

    // Body focus — Esc stops the run (last-resort contract).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onStop).toHaveBeenCalledTimes(1)

    // Commit message / search / xterm input focus — Esc belongs to the field,
    // it must not silently cancel a streaming run.
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onStop).toHaveBeenCalledTimes(1)
    input.remove()
  })

  it('still stops when focus is in the main composer', () => {
    const onStop = vi.fn()
    setup(onStop)

    const composer = document.createElement('div')
    composer.setAttribute('role', 'textbox')
    composer.setAttribute('aria-label', 'Message')
    composer.contentEditable = 'true'
    document.body.appendChild(composer)
    composer.focus()
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onStop).toHaveBeenCalledTimes(1)
    composer.remove()
  })
})

describe('useAppShortcuts workspace switching', () => {
  it('routes Ctrl/Cmd+1..9 to onSwitchWorkspaceByIndex and rejects unmodified/alt/shift digits', () => {
    const onSwitchWorkspaceByIndex = vi.fn()
    renderHook(() =>
      useAppShortcuts({
        onToggleSidebar: () => {},
        onFocusSearch: () => {},
        onClearSearchFocus: () => {},
        isSearchFocused: () => false,
        onNewChat: () => {},
        onOpenSettings: () => {},
        onSwitchWorkspaceByIndex
      })
    )

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true }))
    expect(onSwitchWorkspaceByIndex).toHaveBeenCalledTimes(1)
    expect(onSwitchWorkspaceByIndex).toHaveBeenCalledWith(1)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, altKey: true }))
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '2', ctrlKey: true, shiftKey: true })
    )
    expect(onSwitchWorkspaceByIndex).toHaveBeenCalledTimes(1)
  })
})
