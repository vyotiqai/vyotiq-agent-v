import { useCallback, useEffect, useRef, useState } from 'react'

const STYLE_ID = 'vyotiq-user-skin'

/**
 * Skin palettes live in `[data-skin][data-theme]` blocks — specificity (0,2,0)
 * — so a user's `:root { --vy-* }` at (0,1,0) loses no matter where it sits in
 * the document. The overlay is documented as the last word over the active
 * skin, so re-assert its custom properties as `!important` once the sheet
 * parses. Relative order inside the user's own CSS is untouched: every one of
 * its declarations gains the same priority.
 */
function forceCustomPropertyPriority(rules: CSSRuleList): void {
  for (const rule of Array.from(rules)) {
    const style = (rule as CSSStyleRule).style
    if (style) {
      for (const prop of Array.from(style)) {
        if (!prop.startsWith('--')) continue
        style.setProperty(prop, style.getPropertyValue(prop), 'important')
      }
    }
    // Not an else: with CSS nesting a style rule carries `cssRules` of its own,
    // so a grouping check here would skip every declaration above it.
    const nested = (rule as CSSGroupingRule).cssRules
    if (nested) forceCustomPropertyPriority(nested)
  }
}

function applyUserSkinCss(css: string): void {
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = css
  try {
    const sheet = (el as HTMLStyleElement).sheet
    if (sheet) forceCustomPropertyPriority(sheet.cssRules)
  } catch {
    // CSSOM unavailable (or the sheet was not parsed): leave the raw text,
    // which still applies wherever specificity allows.
  }
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
