import { useEffect, useState } from 'react'
import type { Settings } from '@shared/ipc'

/**
 * One setting, read for a component that is not handed the settings object:
 * the saved value once mounted, then every change. `fallback` stands in until
 * the first read lands, and wherever the bridge is missing (tests).
 */
export function useSettingValue<K extends keyof Settings>(key: K, fallback: Settings[K]): Settings[K] {
  const [value, setValue] = useState<Settings[K]>(fallback)
  useEffect(() => {
    let cancelled = false
    void window.vyotiq
      ?.getSettings?.()
      .then((res) => {
        if (!cancelled && res.ok && res.data[key] !== undefined) setValue(res.data[key])
      })
      .catch(() => undefined)
    const off = window.vyotiq?.onSettingsChanged?.((next) => {
      if (next[key] !== undefined) setValue(next[key])
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [key])
  return value
}
