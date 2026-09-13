import { useLayoutEffect, type RefObject } from 'react'
import { COMPOSER_TEXTAREA_MAX_PX } from '@renderer/lib/utils/layout'

export function useAutoGrowTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, COMPOSER_TEXTAREA_MAX_PX)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > COMPOSER_TEXTAREA_MAX_PX ? 'auto' : 'hidden'
  }, [ref, value])
}
