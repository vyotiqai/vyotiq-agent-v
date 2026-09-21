import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

type TitleBarAccessoryContextValue = {
  host: HTMLElement | null
  setHost: (el: HTMLElement | null) => void
  /** True while immersive or side-dock tabs occupy the titlebar accessory slot. */
  occupied: boolean
  setOccupied: (occupied: boolean) => void
  /**
   * True while a surface in the main column draws its own chrome across the
   * title-bar band (see {@link useTitleBarBand}). The TitleBar stops claiming
   * the band as a window-drag region while that holds, because a drag region
   * swallows every click over it — including the claimed chrome's own buttons.
   */
  bandClaimed: boolean
  /** Claim the band for one surface; call the returned function to release it. */
  claimBand: () => () => void
}

const TitleBarAccessoryContext = createContext<TitleBarAccessoryContextValue>({
  host: null,
  setHost: () => undefined,
  occupied: false,
  setOccupied: () => undefined,
  bandClaimed: false,
  claimBand: () => () => undefined
})

export function TitleBarAccessoryProvider({ children }: { children: ReactNode }) {
  const [host, setHostState] = useState<HTMLElement | null>(null)
  const [occupied, setOccupied] = useState(false)
  const [bandClaimed, setBandClaimed] = useState(false)
  // Panes mount and unmount independently, so the band is refcounted rather
  // than a single flag: the last surface to leave releases it.
  const bandClaims = useRef(0)
  const setHost = useCallback((el: HTMLElement | null) => {
    setHostState(el)
  }, [])

  const claimBand = useCallback((): (() => void) => {
    bandClaims.current += 1
    setBandClaimed(true)
    let released = false
    return () => {
      if (released) return
      released = true
      bandClaims.current = Math.max(0, bandClaims.current - 1)
      if (bandClaims.current === 0) setBandClaimed(false)
    }
  }, [])

  const value = useMemo(
    () => ({ host, setHost, occupied, setOccupied, bandClaimed, claimBand }),
    [host, setHost, occupied, bandClaimed, claimBand]
  )

  return (
    <TitleBarAccessoryContext.Provider value={value}>{children}</TitleBarAccessoryContext.Provider>
  )
}

export function useTitleBarAccessory(): TitleBarAccessoryContextValue {
  return useContext(TitleBarAccessoryContext)
}

/**
 * Set for a subtree whose own chrome already spent the title-bar band, so a
 * nested header (an instance pane inside a multi-pane column, say) knows it is
 * an ordinary row rather than a second claimant of the same 36px.
 */
const TitleBarBandSpentContext = createContext(false)

export function TitleBarBandSpent({ children }: { children: ReactNode }) {
  return (
    <TitleBarBandSpentContext.Provider value={true}>{children}</TitleBarBandSpentContext.Provider>
  )
}

/**
 * Whether this surface's top row sits *inside* the title-bar band — the
 * `TITLE_BAR_HEIGHT` strip the TitleBar overlay owns across the top of the main
 * column, with the window-drag region on the left and the caption buttons on
 * the right.
 *
 * It does when nothing above it has already cleared the band: the accessory
 * slot is empty (no dock tabs, so ChatView adds no `pt-9`) and no ancestor
 * declared the band {@link TitleBarBandSpent}. Chrome that lands in the band
 * has to match the band's height, mark its controls `app-region-no-drag`, and
 * hold `windowControlsReservePx()` open on its right edge — otherwise it reads
 * as colliding with the caption buttons and is dead to the mouse besides.
 *
 * Pass `claim: false` to read the answer without claiming the band (a surface
 * that only reacts to it rather than drawing into it).
 */
export function useTitleBarBand(claim = true): boolean {
  const spent = useContext(TitleBarBandSpentContext)
  const { occupied, claimBand } = useTitleBarAccessory()
  const inBand = !spent && !occupied

  useEffect(() => {
    if (!inBand || !claim) return
    return claimBand()
  }, [inBand, claim, claimBand])

  return inBand
}
