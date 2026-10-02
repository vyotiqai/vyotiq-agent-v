export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * How a scroll the app makes moves: a glide, or straight there when motion is
 * reduced. The stylesheet stills CSS motion; a script's `behavior: 'smooth'`
 * is not CSS and glided anyway.
 */
export function scrollMotion(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}
