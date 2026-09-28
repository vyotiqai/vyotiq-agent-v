/** Standard focusable selector for focus trap and initial focus. */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

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

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true'
  )
}
