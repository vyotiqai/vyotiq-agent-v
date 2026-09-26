/** True when the Changes or PR dock is visible and should own Ctrl+F. */
export function isChangesOrPrDockClaimingFind(): boolean {
  if (typeof document === 'undefined') return false
  for (const id of ['dock-panel-changes', 'dock-panel-pr'] as const) {
    const el = document.getElementById(id)
    if (!el) continue
    if (el.hasAttribute('inert')) continue
    if (el.getAttribute('aria-hidden') === 'true') continue
    if (el.classList.contains('hidden')) continue
    return true
  }
  return false
}
