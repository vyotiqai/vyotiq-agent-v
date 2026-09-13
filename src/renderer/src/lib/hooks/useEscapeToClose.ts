import { useEffect } from 'react'

export function useEscapeToClose(
  onClose: () => void,
  enabled: boolean,
  opts?: { deferToMenus?: boolean; capture?: boolean }
): void {
  const { deferToMenus = false, capture = false } = opts ?? {}

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      const target = e.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return
        }
      }
      if (deferToMenus && document.querySelector('[aria-expanded="true"][aria-haspopup]')) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, capture)
    return () => window.removeEventListener('keydown', onKey, capture)
  }, [enabled, onClose, deferToMenus, capture])
}
