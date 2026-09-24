import { createContext, useContext } from 'react'

/**
 * The navigator's column, lent to a view that brings its own index — Settings.
 *
 * The shell keeps owning the column: its width, the resize handle, hiding it
 * with the navigator toggle and the drawer below the desktop breakpoint. The
 * view renders into the element through a portal, so its index keeps the
 * view's own state. `null` when no column is lent (another view, or the
 * navigator is hidden), and the view then falls back to an inline index.
 */
export const NavigatorSlotContext = createContext<HTMLElement | null>(null)

export function useNavigatorSlot(): HTMLElement | null {
  return useContext(NavigatorSlotContext)
}
