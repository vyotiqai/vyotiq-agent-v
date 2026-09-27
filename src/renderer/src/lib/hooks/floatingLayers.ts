/**
 * How many menus and popovers are open right now.
 *
 * A menu handles its own Escape on the document in the bubble phase, but a
 * Dialog listens in the capture phase so it can close before anything under
 * it reacts. With a menu open inside the dialog, that order closed the whole
 * dialog and left the menu's Escape nothing to do. Surfaces that close on
 * Escape ask this first and stand down while a menu is open; the menu closes
 * on that key, and the next Escape reaches the dialog.
 */

let openLayers = 0

/** Mark a menu or popover open; call the returned function when it closes. */
export function holdFloatingLayer(): () => void {
  openLayers += 1
  let released = false
  return () => {
    if (released) return
    released = true
    openLayers -= 1
  }
}

export function hasOpenFloatingLayer(): boolean {
  return openLayers > 0
}

/** Test helper: forget layers a failed case left open. */
export function resetFloatingLayersForTests(): void {
  openLayers = 0
}
