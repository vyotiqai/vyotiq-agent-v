import { useSyncExternalStore } from 'react'
import {
  INSPECTOR_TAB_SHORTCUTS,
  SHORTCUT_BINDINGS,
  WORKSPACE_SWITCH_IDS,
  type ShortcutBinding,
  type ShortcutId,
  type ShortcutShift
} from './bindings'

/**
 * The one place a shortcut's keys are read from: the built-in binding, or
 * the user's override from Settings → Shortcuts. matchShortcut and
 * shortcutLabel both come here, so every caller follows a rebinding.
 */

export type ShortcutChord = Omit<ShortcutBinding, 'id'>

/**
 * Not offered for rebinding: Esc stops a run from anywhere, and the numbered
 * sets (workspace 1–9, inspector tabs 1–6) are positions, not commands.
 */
const FIXED = new Set<ShortcutId>(['stop', ...WORKSPACE_SWITCH_IDS, ...INSPECTOR_TAB_SHORTCUTS])

export function isRebindable(id: ShortcutId): boolean {
  return id in SHORTCUT_BINDINGS && !FIXED.has(id)
}

let overrides: Partial<Record<ShortcutId, ShortcutChord>> = {}
let signature = '{}'
let version = 0
const listeners = new Set<() => void>()

export function getBinding(id: ShortcutId): ShortcutBinding {
  const own = overrides[id]
  return own ? { id, ...own } : SHORTCUT_BINDINGS[id]
}

/**
 * Take the saved overrides (unknown ids and fixed shortcuts are ignored).
 * Silent, so App can call it while rendering and every child in that render
 * reads the new keys; `notifyShortcutListeners` then updates memoized ones.
 * Returns whether anything changed.
 */
export function applyShortcutOverrides(map: Readonly<Record<string, ShortcutChord>> | undefined): boolean {
  const next: Partial<Record<ShortcutId, ShortcutChord>> = {}
  for (const [id, chord] of Object.entries(map ?? {})) {
    if (isRebindable(id as ShortcutId)) next[id as ShortcutId] = chord
  }
  const sig = JSON.stringify(next)
  if (sig === signature) return false
  overrides = next
  signature = sig
  version += 1
  return true
}

export function notifyShortcutListeners(): void {
  for (const listener of listeners) listener()
}

/** Re-render when shortcuts are rebound (for memoized labels). */
export function useShortcutsVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => version,
    () => version
  )
}

const NAMED_KEYS = new Set(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'])

/**
 * The chord a key press asks for, or null while it's only modifiers or a key
 * that can't hold a shortcut. Letters and digits come from the physical key,
 * so Shift+1 records as 1, not "!".
 */
export function chordFromEvent(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): ShortcutChord | null {
  if (['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock'].includes(e.key)) return null
  let key = e.key.toLowerCase()
  const code = e.code ?? ''
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase()
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  if (key.length !== 1 && !NAMED_KEYS.has(key)) return null
  const mod = e.ctrlKey || e.metaKey
  if (mod && !e.altKey) return { key, mod: true, shift: e.shiftKey ? 'require' : 'forbid' }
  if (e.altKey && !mod && !e.shiftKey) return { key, mod: false, alt: true }
  // A bare function key is a chord of its own; a bare letter would steal typing.
  if (!mod && !e.altKey && NAMED_KEYS.has(key)) return { key, mod: false, shift: e.shiftKey ? 'require' : 'forbid' }
  return null
}

function shiftsOverlap(a: ShortcutShift | undefined, b: ShortcutShift | undefined): boolean {
  const x = a ?? 'forbid'
  const y = b ?? 'forbid'
  return x === 'allow' || y === 'allow' || x === y
}

/** True when one key press would fire both. */
export function chordsCollide(a: ShortcutChord, b: ShortcutChord): boolean {
  return a.key === b.key && a.mod === b.mod && Boolean(a.alt) === Boolean(b.alt) && shiftsOverlap(a.shift, b.shift)
}

/** Another shortcut the chord would also fire, or null. */
export function findShortcutConflict(id: ShortcutId, chord: ShortcutChord): ShortcutId | null {
  for (const other of Object.keys(SHORTCUT_BINDINGS) as ShortcutId[]) {
    if (other === id) continue
    if (chordsCollide(getBinding(other), chord)) return other
  }
  return null
}

/**
 * Why a chord can't be used, when the system or the text fields already own
 * it: clipboard and undo, text size, and on macOS the app's own Hide, Quit
 * and Minimize.
 */
export function reservedChordReason(chord: ShortcutChord, darwin: boolean): string | null {
  if (chord.mod && !chord.alt) {
    if (['c', 'v', 'x', 'z', 'y', 'a'].includes(chord.key)) return 'Text fields use it for copy, paste and undo.'
    if (['-', '=', '0', '+'].includes(chord.key)) return 'It sets the text size.'
    if (darwin && ['h', 'q', 'm'].includes(chord.key) && chord.shift !== 'require') return 'macOS uses it to hide, quit or minimize.'
  }
  return null
}

export function resetShortcutRegistryForTests(): void {
  overrides = {}
  signature = '{}'
  version += 1
}
