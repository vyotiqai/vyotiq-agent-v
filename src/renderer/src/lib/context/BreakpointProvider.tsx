import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { LG_BREAKPOINT } from '@renderer/lib/utils/breakpoints'
import { useMediaQuery } from '@renderer/lib/hooks/useMediaQuery'

type BreakpointContextValue = {
  isDesktop: boolean
}

const BreakpointContext = createContext<BreakpointContextValue>({ isDesktop: true })

export function BreakpointProvider({ children }: { children: ReactNode }) {
  const isDesktop = useMediaQuery(LG_BREAKPOINT, true)
  const value = useMemo(() => ({ isDesktop }), [isDesktop])
  return <BreakpointContext.Provider value={value}>{children}</BreakpointContext.Provider>
}

export function useIsDesktop(): boolean {
  return useContext(BreakpointContext).isDesktop
}
