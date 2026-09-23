/**
 * Whether Escape-to-stop should yield to another Esc handler.
 * Last-resort gate for the bubble-phase app shortcut listener — not capture steal.
 */
export function shouldDeferAppEscapeStop(opts?: {
  drawerOpen?: boolean
  hasSessionQuery?: boolean
}): boolean {
  if (opts?.drawerOpen) return true
  if (opts?.hasSessionQuery) return true

  // Open popup / menu (ActionMenu, ModelPicker, etc.)
  if (document.querySelector('[aria-expanded="true"][aria-haspopup]')) return true

  // Overlay drawer, lightbox, or other modal dialog
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return true

  // A pending approval does not take Esc: Alt D denies it, and Esc still
  // stops the run as it does everywhere else.

  // Sidebar inline delete / workspace-close confirm (Esc cancels, must not stop run)
  if (document.querySelector('[data-inline-confirm]')) return true

  // Focus-opened custom Tooltip only — hover tips must not block stop
  if (document.querySelector('[role="tooltip"][data-opened-by="focus"]')) return true

  // Composer mention / slash menus (portal listboxes)
  if (document.querySelector('[role="listbox"][aria-label="Slash commands"]')) return true
  if (document.querySelector('[role="listbox"][aria-label="Mentions"]')) return true

  // In-composer dictation strip — Esc cancels listening / ignores in-flight transcribe
  if (document.querySelector('[data-dictation-session]')) return true

  // Inline cancel-edit composer — Escape cancels the edit
  const inline = document.querySelector('[data-composer-inline]')
  if (inline && document.activeElement && inline.contains(document.activeElement)) {
    return true
  }

  // Find in a panel or the record, a title or PR title edit — Esc closes those UIs first
  const active = document.activeElement as HTMLElement | null
  if (active) {
    const label = active.getAttribute('aria-label')
    if (
      label === 'Find in changes' ||
      label === 'Find in diff' ||
      label === 'Find in record' ||
      label === 'Task title' ||
      label === 'PR title'
    ) {
      return true
    }
  }

  return false
}
