import { SHORTCUT_BINDINGS, type ShortcutId } from './bindings'

/**
 * The composer's editable field, in every form it takes — the New task brief,
 * the instruction line, an inline edit. Matched by attribute rather than by
 * accessible name, which differs between them ("Message", "Instruction").
 */
export const COMPOSER_MESSAGE_SELECTOR = '[data-composer-input]'

/** Browser dock URL field. */
export const BROWSER_URL_SELECTOR = '[data-browser-url]'

export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
> &
  Partial<Pick<KeyboardEvent, 'code'>>

/**
 * Shifted punctuation glyph → base key. With Shift held, `.` produces `>`
 * on US layouts; map the glyph back so `shift: 'allow'` chords match.
 */
const SHIFTED_PUNCTUATION: Record<string, string> = {
  '>': '.'
}

/**
 * True when `e` matches the binding for `id`.
 * Mod chords require Cmd/Ctrl and reject Alt.
 * Shift is forbidden unless the binding sets `shift: 'allow'` or `'require'`.
 * Escape (stop) ignores Ctrl/Meta/Alt/Shift so modified Esc never stops a run.
 */
export function matchShortcut(e: ShortcutKeyEvent, id: ShortcutId): boolean {
  const binding = SHORTCUT_BINDINGS[id]
  if (binding.alt) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
    // Option+digit types a symbol on macOS; the physical key still says which.
    return e.key.toLowerCase() === binding.key || e.code === `Digit${binding.key}`
  }
  // Shifted punctuation (e.g. Shift+'.' produces '>' on US layouts) maps to
  // its base key so `shift: 'allow'` chords like Cmd/Ctrl+Shift+. match.
  const eventKey = SHIFTED_PUNCTUATION[e.key] ?? e.key.toLowerCase()
  if (eventKey !== binding.key) return false
  if (binding.mod) {
    if (!(e.metaKey || e.ctrlKey)) return false
    if (e.altKey) return false
    const shiftMode = binding.shift ?? 'forbid'
    switch (shiftMode) {
      case 'forbid':
        if (e.shiftKey) return false
        break
      case 'allow':
        break
      case 'require':
        if (!e.shiftKey) return false
        break
      default: {
        const _exhaustive: never = shiftMode
        return _exhaustive
      }
    }
    return true
  }
  if (id === 'stop') {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false
  }
  return true
}

/** True when the event target is a text field where app chords should not steal. */
export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  return Boolean(el.isContentEditable)
}

/** True when the event originated in the main chat composer. */
export function isMainComposerTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (typeof el.closest === 'function') {
    return Boolean(el.closest(COMPOSER_MESSAGE_SELECTOR))
  }
  return Boolean(el.hasAttribute?.('data-composer-input'))
}

/**
 * True when window-level app chords (new chat, settings, sidebar, search)
 * should not run — editable fields except the main composer.
 */
export function shouldBlockAppShortcut(target: EventTarget | null): boolean {
  return isEditableShortcutTarget(target) && !isMainComposerTarget(target)
}

/**
 * Dock panel chords should run from the composer and from xterm (toggle-close),
 * but not from rename fields or settings inputs.
 */
export function shouldBlockPanelShortcut(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.classList?.contains('xterm-helper-textarea')) return false
  if (isMainComposerTarget(el)) return false
  return isEditableShortcutTarget(el)
}

/**
 * Focus the Message composer — the first on the page, or the one inside
 * `within` (a pane, when there are several). Returns whether focus landed on it.
 */
export function focusComposerMessage(within?: ParentNode | null): boolean {
  const candidates = (within ?? document).querySelectorAll<HTMLElement>(COMPOSER_MESSAGE_SELECTOR)
  for (const el of candidates) {
    if (el.getAttribute('contenteditable') === 'false') continue
    el.focus()
    if (document.activeElement === el) return true
  }
  return false
}

/**
 * Focus the browser URL field when the browser dock is visible (not inert).
 * Returns whether focus landed on it.
 */
export function focusBrowserUrlIfOpen(): boolean {
  const el = document.querySelector(BROWSER_URL_SELECTOR) as HTMLInputElement | null
  if (!el) return false
  if (typeof el.closest === 'function' && el.closest('[inert]')) return false
  el.focus()
  if (typeof el.select === 'function') el.select()
  return document.activeElement === el
}
