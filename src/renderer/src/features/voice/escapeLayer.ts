import { hasOpenFloatingLayer } from '@renderer/lib/hooks/floatingLayers'

/** An open menu, popover, modal dialog, or the view's own settings popover or history drawer: Escape closes that first. */
export function escapeBelongsToALayer(): boolean {
  return (
    hasOpenFloatingLayer() ||
    document.querySelector('[aria-expanded="true"][aria-haspopup], dialog[open], [aria-modal="true"], [data-voice-pop], [data-voice-drawer]') !== null
  )
}
