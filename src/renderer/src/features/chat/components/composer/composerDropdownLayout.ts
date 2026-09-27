/** Shared viewport clamping for composer portal dropdowns (options / mention / slash / context). */

export const COMPOSER_DROPDOWN_PAD_PX = 8

export type ComposerDropdownPlacement = 'up' | 'down'

export type ComposerDropdownPosition = {
  left: number
  top: number
  placement: ComposerDropdownPlacement
}

/**
 * Clamp panel left/width/maxHeight to the viewport.
 * Does not use anchor width — full-width composer anchors must not stretch menus.
 */
export function clampComposerDropdownPanel(opts: {
  position: ComposerDropdownPosition
  maxWidthPx: number
  minHeightPx?: number
  viewportWidth?: number
  viewportHeight?: number
}): { left: number; width: number; maxHeight: number } {
  const pad = COMPOSER_DROPDOWN_PAD_PX
  const vw = opts.viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1024)
  const vh = opts.viewportHeight ?? (typeof window !== 'undefined' ? window.innerHeight : 768)
  const minH = opts.minHeightPx ?? 200

  const width = Math.min(opts.maxWidthPx, Math.max(0, vw - pad * 2))
  const left = Math.max(pad, Math.min(opts.position.left, vw - width - pad))
  const free =
    opts.position.placement === 'up'
      ? opts.position.top - pad
      : vh - opts.position.top - pad
  const maxHeight = Math.min(Math.max(minH, free), Math.round(vh * 0.7))

  return { left, width, maxHeight }
}

/** Path tree needs ~140px; hide it when the clamped panel cannot fit list + tree. */
export const COMPOSER_DROPDOWN_TREE_MIN_PX = 360
