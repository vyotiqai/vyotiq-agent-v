import { useVirtualizer } from '@tanstack/react-virtual'

/**
 * TanStack Virtual returns unstable functions. React Compiler cannot memoize
 * callers, so this hook opts out of memoization at the boundary.
 */
export function useAppVirtualizer(
  options: Parameters<typeof useVirtualizer>[0]
): ReturnType<typeof useVirtualizer> {
  'use no memo'
  return useVirtualizer(options)
}
