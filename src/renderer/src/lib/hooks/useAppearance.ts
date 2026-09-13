import { useCallback, useEffect, useRef, useState } from 'react'
import type { FontScale, UiDensity } from '@shared/appearance'
import {
  pickAppearanceSettings,
  resolveAppearanceBootCache,
  writeAppearanceBootCache,
  type AppearanceSettings
} from '@shared/appearance'
import type { ThemeId } from '@shared/ipc'
import { resolveTheme, type ResolvedTheme } from '@shared/theme'

export type AppearanceState = AppearanceSettings & {
  resolvedTheme: ResolvedTheme
}

function readSystemDark(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyToDocument(
  appearance: AppearanceSettings,
  resolvedTheme: ResolvedTheme
): void {
  const root = document.documentElement
  root.setAttribute('data-theme', resolvedTheme)
  root.setAttribute('data-font-scale', appearance.fontScale)
  root.setAttribute('data-density', appearance.uiDensity)
  root.setAttribute('data-skin', appearance.skinId)
  writeAppearanceBootCache(resolveAppearanceBootCache(appearance, resolvedTheme === 'dark'))
}

/**
 * Applies persisted appearance settings to the DOM.
 * Persistence lives in useSettings.update; this hook owns live DOM + boot cache.
 */
export function useAppearance(initial: AppearanceSettings) {
  const [appearance, setAppearanceState] = useState<AppearanceState>(() => {
    const systemDark = readSystemDark()
    const resolvedTheme = resolveTheme(initial.theme, systemDark)
    return { ...initial, resolvedTheme }
  })
  const systemDarkRef = useRef(readSystemDark())
  const appearanceRef = useRef(appearance)
  appearanceRef.current = appearance

  const apply = useCallback((next: AppearanceSettings, systemDark = systemDarkRef.current) => {
    const resolvedTheme = resolveTheme(next.theme, systemDark)
    applyToDocument(next, resolvedTheme)
    setAppearanceState({ ...next, resolvedTheme })
  }, [])

  useEffect(() => {
    apply(pickAppearanceSettings(appearanceRef.current), systemDarkRef.current)
    document.documentElement.setAttribute(
      'data-window-focused',
      document.hasFocus() ? 'true' : 'false'
    )
  }, [apply])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onMediaChange = (): void => {
      systemDarkRef.current = mq.matches
      if (appearanceRef.current.theme === 'system') {
        apply(pickAppearanceSettings(appearanceRef.current), mq.matches)
      }
    }
    mq.addEventListener('change', onMediaChange)

    let disposeIpc: (() => void) | undefined
    let disposeFocusIpc: (() => void) | undefined
    if (window.vyotiq?.onSystemThemeChanged) {
      disposeIpc = window.vyotiq.onSystemThemeChanged((prefersDark) => {
        systemDarkRef.current = prefersDark
        if (appearanceRef.current.theme === 'system') {
          apply(pickAppearanceSettings(appearanceRef.current), prefersDark)
        }
      })
      void window.vyotiq.getSystemTheme().then((res) => {
        if (!res.ok) return
        systemDarkRef.current = res.data
        if (appearanceRef.current.theme === 'system') {
          apply(pickAppearanceSettings(appearanceRef.current), res.data)
        }
      })
    }
    if (window.vyotiq?.onWindowFocusChanged) {
      disposeFocusIpc = window.vyotiq.onWindowFocusChanged((focused) => {
        document.documentElement.setAttribute('data-window-focused', focused ? 'true' : 'false')
      })
    }

    return () => {
      mq.removeEventListener('change', onMediaChange)
      disposeIpc?.()
      disposeFocusIpc?.()
    }
  }, [apply])

  const setAppearance = useCallback(
    (partial: Partial<AppearanceSettings>) => {
      const next = { ...pickAppearanceSettings(appearanceRef.current), ...partial }
      apply(next, systemDarkRef.current)
    },
    [apply]
  )

  const hydrate = useCallback(
    (settings: AppearanceSettings) => {
      setAppearanceState((prev) => {
        const next = pickAppearanceSettings(settings)
        const resolvedTheme = resolveTheme(next.theme, systemDarkRef.current)
        applyToDocument(next, resolvedTheme)
        if (
          prev.theme === next.theme &&
          prev.fontScale === next.fontScale &&
          prev.uiDensity === next.uiDensity &&
          prev.skinId === next.skinId &&
          prev.customCssPath === next.customCssPath &&
          prev.resolvedTheme === resolvedTheme
        ) {
          return prev
        }
        return { ...next, resolvedTheme }
      })
    },
    []
  )

  const toggleTheme = useCallback(() => {
    const nextTheme: ThemeId = appearanceRef.current.resolvedTheme === 'dark' ? 'light' : 'dark'
    setAppearance({ theme: nextTheme })
  }, [setAppearance])

  return {
    appearance,
    resolvedTheme: appearance.resolvedTheme,
    theme: appearance.theme,
    fontScale: appearance.fontScale as FontScale,
    uiDensity: appearance.uiDensity as UiDensity,
    skinId: appearance.skinId,
    customCssPath: appearance.customCssPath,
    setAppearance,
    toggleTheme,
    hydrate
  }
}
