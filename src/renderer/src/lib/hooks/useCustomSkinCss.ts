import { useCallback, useEffect, useRef, useState } from 'react'

const STYLE_ID = 'vyotiq-user-skin'

function applyUserSkinCss(css: string): void {
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = css
}

/**
 * Loads and injects local user CSS overlay on top of the active skin.
 * Keeps the last successfully applied CSS when a read fails.
 */
export function useCustomSkinCss(customCssPath: string): { customCssError: string | null } {
  const lastGoodCssRef = useRef('')
  const [customCssError, setCustomCssError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!window.vyotiq?.appearanceReadCustomCss) return
    const res = await window.vyotiq.appearanceReadCustomCss()
    if (res.ok) {
      lastGoodCssRef.current = res.data.css
      applyUserSkinCss(res.data.css)
      setCustomCssError(null)
      return
    }
    if (customCssPath.trim()) {
      setCustomCssError(res.error)
      applyUserSkinCss(lastGoodCssRef.current)
      return
    }
    applyUserSkinCss('')
    lastGoodCssRef.current = ''
    setCustomCssError(null)
  }, [customCssPath])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const dispose = window.vyotiq?.onAppearanceCustomCssChanged?.(() => {
      void load()
    })
    return () => dispose?.()
  }, [load])

  return { customCssError }
}
