/* global localStorage, document, window */
;(function () {
  function resolvedThemeFromSystem() {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  }

  function applyAppearanceFromCache(root, cache) {
    var theme =
      cache &&
      (cache.resolvedTheme === 'light' || cache.resolvedTheme === 'dark')
        ? cache.resolvedTheme
        : resolvedThemeFromSystem()
    root.setAttribute('data-theme', theme)

    var fontScale =
      cache &&
      (cache.fontScale === 'small' ||
        cache.fontScale === 'default' ||
        cache.fontScale === 'large')
        ? cache.fontScale
        : 'default'
    root.setAttribute('data-font-scale', fontScale)

    var density =
      cache &&
      (cache.uiDensity === 'compact' ||
        cache.uiDensity === 'default' ||
        cache.uiDensity === 'comfortable')
        ? cache.uiDensity
        : 'default'
    root.setAttribute('data-density', density)

    var skin =
      cache &&
      (cache.skinId === 'default' ||
        cache.skinId === 'proof' ||
        cache.skinId === 'bench' ||
        cache.skinId === 'native')
        ? cache.skinId
        : 'default'
    root.setAttribute('data-skin', skin)
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
