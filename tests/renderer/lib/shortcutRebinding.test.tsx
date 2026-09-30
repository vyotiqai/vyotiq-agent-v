/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  applyShortcutOverrides,
  chordFromEvent,
  findShortcutConflict,
  getBinding,
  matchShortcut,
  reservedChordReason,
  shortcutLabel
} from '@renderer/lib/shortcuts'
import { resetShortcutRegistryForTests } from '@renderer/lib/shortcuts/registry'
import { ShortcutsSection } from '@renderer/features/settings/sections/ShortcutsSection'
import type { SettingsFormState } from '@renderer/features/settings/hooks/useSettingsForm'
import { DEFAULT_SETTINGS } from '@shared/ipc'

const key = (k: string, over: Partial<KeyboardEvent> = {}) => ({
  key: k,
  code: /^[a-z]$/.test(k) ? `Key${k.toUpperCase()}` : /^[0-9]$/.test(k) ? `Digit${k}` : '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over
})

afterEach(() => {
  cleanup()
  resetShortcutRegistryForTests()
})

describe('shortcut registry', () => {
  it('reads an override for matching and the label, and ignores fixed or unknown ids', () => {
    applyShortcutOverrides({ newChat: { key: 't', mod: true, shift: 'require' }, stop: { key: 'q', mod: true }, bogus: { key: 'x', mod: true } })
    expect(getBinding('newChat')).toMatchObject({ key: 't', shift: 'require' })
    expect(matchShortcut(key('t', { ctrlKey: true, shiftKey: true }), 'newChat')).toBe(true)
    expect(matchShortcut(key('n', { ctrlKey: true }), 'newChat')).toBe(false)
    expect(shortcutLabel('newChat')).toBe('Ctrl+Shift+T')
    // Esc stays Esc.
    expect(getBinding('stop').key).toBe('escape')
  })

  it('records chords from key presses by physical key, and refuses plain typing', () => {
    expect(chordFromEvent(key('!', { code: 'Digit1', ctrlKey: true, shiftKey: true }))).toEqual({ key: '1', mod: true, shift: 'require' })
    expect(chordFromEvent(key('k', { altKey: true }))).toEqual({ key: 'k', mod: false, alt: true })
    expect(chordFromEvent(key('F5'))).toEqual({ key: 'f5', mod: false, shift: 'forbid' })
    expect(chordFromEvent(key('a'))).toBeNull()
    expect(chordFromEvent(key('Control', { ctrlKey: true }))).toBeNull()
  })

  it('finds the shortcut a chord would also fire, and keys the system owns', () => {
    expect(findShortcutConflict('newChat', { key: 'b', mod: true, shift: 'forbid' })).toBe('sidebar')
    // Ctrl+B and Ctrl+Shift+B are different chords.
    expect(findShortcutConflict('newChat', { key: 'b', mod: true, shift: 'require' })).toBe('panelBrowser')
    expect(findShortcutConflict('newChat', { key: 'u', mod: true, shift: 'forbid' })).toBeNull()
    expect(reservedChordReason({ key: 'c', mod: true, shift: 'forbid' }, false)).toMatch(/copy/)
    expect(reservedChordReason({ key: '=', mod: true, shift: 'forbid' }, false)).toMatch(/text size/)
    expect(reservedChordReason({ key: 'h', mod: true, shift: 'forbid' }, true)).toMatch(/macOS/)
    expect(reservedChordReason({ key: 'h', mod: true, shift: 'forbid' }, false)).toBeNull()
  })
})

describe('Settings → Shortcuts rebinding', () => {
  function formWith(overrides: Record<string, unknown>) {
    const runUpdate = vi.fn(async () => true)
    const form = {
      settings: { ...DEFAULT_SETTINGS, shortcutOverrides: overrides },
      formLocked: false,
      runUpdate
    } as unknown as SettingsFormState
    return { form, runUpdate }
  }

  it('records a new chord, refuses a taken one with its name, and resets', () => {
    const { form, runUpdate } = formWith({})
    const { rerender } = render(<ShortcutsSection form={form} />)
    fireEvent.click(screen.getByRole('button', { name: 'Change the shortcut for New task' }))
    expect(screen.getByRole('status').textContent).toBe('Press keys…')

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true }))
    })
    expect(screen.getByRole('alert').textContent).toBe('Show / hide navigator already uses it.')
    expect(runUpdate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Change the shortcut for New task' }))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', code: 'KeyU', ctrlKey: true, bubbles: true }))
    })
    expect(runUpdate).toHaveBeenCalledWith({ shortcutOverrides: { newChat: { key: 'u', mod: true, shift: 'forbid' } } })

    // Saved: the row shows its own Reset, and Reset all appears.
    const saved = formWith({ newChat: { key: 'u', mod: true, shift: 'forbid' } })
    applyShortcutOverrides(saved.form.settings.shortcutOverrides)
    rerender(<ShortcutsSection form={saved.form} />)
    expect(screen.getByRole('button', { name: 'Reset all shortcuts' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset the shortcut for New task' }))
    expect(saved.runUpdate).toHaveBeenCalledWith({ shortcutOverrides: {} })
  })

  it('offers no Change for Esc or the numbered workspace keys', () => {
    const { form } = formWith({})
    render(<ShortcutsSection form={form} />)
    expect(screen.queryByRole('button', { name: 'Change the shortcut for Stop the run' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Change the shortcut for Switch to workspace 1' })).toBeNull()
  })
})
