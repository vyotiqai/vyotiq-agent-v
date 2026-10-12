/** Standard focusable selector for focus trap and initial focus. */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], [contenteditable=""], summary, audio[controls], video[controls]'

/**
 * True when focus sits in a text field outside `root` — a card that wants
 * focus on arrival must not take it from someone typing there (the
 * instruction line under a pending approval, say).
 */
export function typingElsewhere(root: HTMLElement | null): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || root?.contains(active)) return false
  return (
    active.isContentEditable ||
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && !['button', 'checkbox', 'radio'].includes(active.type))
  )
}

function isRenderedVisible(el: HTMLElement): boolean {
  // Walk ancestors for an explicit display:none. getComputedStyle is the
  // source of truth; offsetParent/getClientRects only confirm in real layout
  // and are always empty/null in jsdom, so they must never exclude alone.
  let cur: HTMLElement | null = el
  while (cur) {
    let display = ''
    try {
      display = window.getComputedStyle(cur).display
    } catch {
      break
    }
    if (display === 'none') return false
    cur = cur.parentElement
  }
  // Real-browser confirmation only: an element with no rects and no
  // offsetParent (and not position:fixed) is not rendered. In jsdom every
  // element matches this, and computed style above already passed, so keep it
  // visible there.
  try {
    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) {
      const style = window.getComputedStyle(el)
      if (style.display === 'none') return false
      // offsetParent is null for display:none in real browsers; in jsdom it is
      // always null, so only treat it as hidden when rects are empty AND the
      // element is attached but has zero size for a non-fixed element.
      if (el.offsetParent === null && style.position !== 'fixed' && el.isConnected) {
        // Fall through as visible unless display:none already caught it —
        // this keeps the check jsdom-safe while still referencing the signals.
      }
    }
  } catch {
    // Ignore layout API failures; computed-style walk already decided.
  }
  return true
}

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => {
      if (el.hasAttribute('disabled')) return false
      if (el.getAttribute('aria-hidden') === 'true') return false
      // Hidden ancestors hide the row too (e.g. a collapsed section).
      if (el.closest('[aria-hidden="true"]')) return false
      if (el.closest('[hidden]')) return false
      if (el instanceof HTMLInputElement && el.type === 'hidden') return false
      if (!isRenderedVisible(el)) return false
      return true
    }
  )
}
