import { useEffect, useState } from 'react'

/**
 * The active theme name, tracked from the root element.
 *
 * Anything that bakes colours into markup rather than reading them from CSS —
 * syntax highlighting, notably — has to redo that work when the theme flips.
 */
export function useDocumentTheme(): string {
  const [theme, setTheme] = useState(() =>
    typeof document !== 'undefined' ? (document.documentElement.dataset.theme ?? 'light') : 'light'
  )

  useEffect(() => {
    const root = document.documentElement
    const sync = (): void => {
      setTheme(root.dataset.theme ?? 'light')
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return theme
}
