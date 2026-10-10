export type AppView = 'chat' | 'settings' | 'marketplace' | 'home' | 'usage' | 'screen'

export type ViewReturns = {
  /** Where Settings' Back goes. */
  settings: Exclude<AppView, 'settings'>
  /** Where closing Extensions goes. */
  marketplace: Exclude<AppView, 'marketplace'>
}

/**
 * The way back from Settings and Extensions after a move from `from` to `to`:
 * each remembers the view it was opened from. Going back to the view that
 * opened it (Settings → Extensions → Settings) keeps that view's own way
 * back, so the two never send each other round in a loop.
 */
export function nextViewReturns(from: AppView, to: AppView, returns: ViewReturns): ViewReturns {
  if (from === to) return returns
  if (to === 'settings' && !(from === 'marketplace' && returns.marketplace === 'settings')) {
    return { ...returns, settings: from as ViewReturns['settings'] }
  }
  if (to === 'marketplace' && !(from === 'settings' && returns.settings === 'marketplace')) {
    return { ...returns, marketplace: from as ViewReturns['marketplace'] }
  }
  return returns
}
