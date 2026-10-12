/* global localStorage, document, window */
;(function () {
  function resolvedThemeFromSystem() {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  }

  // Numeric text-scale tail (mirrors FONT_SCALE_MIN/MAX in
  // src/shared/appearance.ts): presets keep working, numbers ride the range.
  function isValidFontScale(value) {
    if (value === 'small' || value === 'default' || value === 'large') return true
    return typeof value === 'number' && isFinite(value) && value >= 0.85 && value <= 2.0
  }

  function fontScaleValue(cache) {
    var scale = cache && cache.fontScale
    return isValidFontScale(scale) ? scale : 'default'
  }

  function applyAppearanceFromCache(root, cache) {
    var theme =
      cache &&
      (cache.resolvedTheme === 'light' || cache.resolvedTheme === 'dark')
        ? cache.resolvedTheme
        : resolvedThemeFromSystem()
    root.setAttribute('data-theme', theme)

    var scale = fontScaleValue(cache)
    root.setAttribute('data-font-scale', String(scale))
    // Presets resolve through the styles.css mapping; a numeric scale sets
    // the token inline so any value in the range applies before the bundle loads.
    try {
      if (typeof scale === 'number') {
        root.style.setProperty('--vy-font-scale', String(scale))
      } else {
        root.style.removeProperty('--vy-font-scale')
      }
    } catch {
      // Ignore style failures — the attribute still carries the scale.
    }

    // Keep the id list and the fallback in step with SKIN_IDS /
    // DEFAULT_SKIN_ID in src/shared/skins.ts — this runs before any
    // bundle loads, so it cannot import them.
    var skin =
      cache &&
      (cache.skinId === 'default' ||
        cache.skinId === 'proof' ||
        cache.skinId === 'bench' ||
        cache.skinId === 'native' ||
        cache.skinId === 'gild')
        ? cache.skinId
        : 'native'
    root.setAttribute('data-skin', skin)

    // Accessibility attributes: default when an older build wrote the cache
    // without them; fall back when a present value is invalid.
    var reduceMotion =
      cache && (cache.reduceMotion === 'on' || cache.reduceMotion === 'off' || cache.reduceMotion === 'system')
        ? cache.reduceMotion
        : 'system'
    root.setAttribute('data-reduce-motion', reduceMotion)

    var contrast =
      cache && (cache.contrast === 'more' || cache.contrast === 'system')
        ? cache.contrast
        : 'system'
    root.setAttribute('data-contrast', contrast)

    root.setAttribute('data-focus-ring', cache && cache.alwaysShowFocusRing === true ? 'always' : 'auto')

    var announce =
      cache &&
      (cache.announceVerbosity === 'off' ||
        cache.announceVerbosity === 'brief' ||
        cache.announceVerbosity === 'full')
        ? cache.announceVerbosity
        : 'full'
    root.setAttribute('data-announce', announce)
  }

  var root = document.documentElement
  try {
    var raw = localStorage.getItem('vyotiq-appearance')
    if (!raw) {
      applyAppearanceFromCache(root, null)
      return
    }
    var cache = JSON.parse(raw)
    applyAppearanceFromCache(root, cache)
  } catch {
    applyAppearanceFromCache(root, null)
  }
})()
