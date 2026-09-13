import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from 'react'

type TitleBarAccessoryContextValue = {
  host: HTMLElement | null
  setHost: (el: HTMLElement | null) => void
  /** True while immersive or side-dock tabs occupy the titlebar accessory slot. */
  occupied: boolean
  setOccupied: (occupied: boolean) => void
}

const TitleBarAccessoryContext = createContext<TitleBarAccessoryContextValue>({
  host: null,
  setHost: () => undefined,
  occupied: false,
  setOccupied: () => undefined
})

export function TitleBarAccessoryProvider({ children }: { children: ReactNode }) {
  const [host, setHostState] = useState<HTMLElement | null>(null)
  const [occupied, setOccupied] = useState(false)
  const setHost = useCallback((el: HTMLElement | null) => {
    setHostState(el)
  }, [])

  const value = useMemo(
    () => ({ host, setHost, occupied, setOccupied }),
    [host, setHost, occupied]
  )

  return (
    <TitleBarAccessoryContext.Provider value={value}>{children}</TitleBarAccessoryContext.Provider>
  )
}

export function useTitleBarAccessory(): TitleBarAccessoryContextValue {
  return useContext(TitleBarAccessoryContext)
}
