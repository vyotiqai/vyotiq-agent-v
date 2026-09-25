import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { isEditableShortcutTarget } from '@renderer/lib/shortcuts'

/** Within this of the bottom, the record follows a live run as it grows. */
const NEAR_BOTTOM_PX = 80
const REPORT_DELAY_MS = 150

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

/**
 * Scrolling for a task record.
 *
 * A record opens at its top — the needs-you card, the result, the brief — or
 * where you left it. While a run is live it follows the growth only if you
 * are already at the bottom, so reading earlier work is never yanked away.
 * Home and End (and the palette's "jump" commands) move to either end.
 */
export function useRecordScroll({
  restoreScrollTop,
  restoreToken,
  onScrollTopChange,
  ready,
  live
}: {
  restoreScrollTop?: number
  /** Changes when the saved position should be applied again (a tab switch). */
  restoreToken?: number
  onScrollTopChange?: (scrollTop: number) => void
  /** The record shows what it will show — not still loading. */
  ready: boolean
  live: boolean
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(false)
  /** A saved position still waiting for the content to be tall enough. */
  const pendingRef = useRef<number | null>(null)
  const programmaticRef = useRef(false)
  const appliedTokenRef = useRef<number | null>(null)
  const reportTimerRef = useRef<number | null>(null)
  const onScrollTopChangeRef = useRef(onScrollTopChange)
  onScrollTopChangeRef.current = onScrollTopChange
  const liveRef = useRef(live)
  liveRef.current = live

  const setTop = useCallback((top: number) => {
    const el = scrollRef.current
    if (!el) return
    programmaticRef.current = true
    el.scrollTop = top
    pinnedRef.current = distanceFromBottom(el) <= NEAR_BOTTOM_PX
  }, [])

  // Apply the saved position once per restore token, when the record is ready.
  useLayoutEffect(() => {
    if (!ready) return
    const token = restoreToken ?? 0
    if (appliedTokenRef.current === token) return
    appliedTokenRef.current = token
    const target = typeof restoreScrollTop === 'number' && restoreScrollTop > 0 ? restoreScrollTop : 0
    setTop(target)
    const el = scrollRef.current
    pendingRef.current = el && Math.abs(el.scrollTop - target) > 1 ? target : null
  }, [ready, restoreToken, restoreScrollTop, setTop])

  // Growth: finish a pending restore, or follow a live run you are at the end of.
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => {
      const pending = pendingRef.current
      if (pending != null) {
        setTop(pending)
        if (Math.abs(el.scrollTop - pending) <= 1) pendingRef.current = null
        return
      }
      if (liveRef.current && pinnedRef.current) setTop(el.scrollHeight)
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [setTop])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (programmaticRef.current) {
      programmaticRef.current = false
    } else {
      // The reader moved: a stale saved position no longer applies.
      pendingRef.current = null
      pinnedRef.current = distanceFromBottom(el) <= NEAR_BOTTOM_PX
    }
    if (reportTimerRef.current != null) window.clearTimeout(reportTimerRef.current)
    reportTimerRef.current = window.setTimeout(() => {
      reportTimerRef.current = null
      if (scrollRef.current) onScrollTopChangeRef.current?.(scrollRef.current.scrollTop)
    }, REPORT_DELAY_MS)
  }, [])

  useEffect(
    () => () => {
      if (reportTimerRef.current != null) window.clearTimeout(reportTimerRef.current)
    },
    []
  )

  const jumpTop = useCallback(() => {
    pendingRef.current = null
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    pinnedRef.current = false
  }, [])

  const jumpBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pendingRef.current = null
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    pinnedRef.current = true
  }, [])

  // Home / End in the focused pane, and the palette's jump commands.
  useEffect(() => {
    const ownsEvent = (target: EventTarget | null): boolean => {
      const el = scrollRef.current
      if (!el) return false
      const pane = el.closest('[data-chat-pane]')
      if (pane?.getAttribute('data-chat-pane-focused') === '0') return false
      const t = target instanceof Element ? target : null
      if (t?.closest('aside[aria-label="Sidebar"], nav[aria-label="Tasks"], [id^="dock-panel-"], [data-chat-side-rail]')) {
        return false
      }
      const other = t?.closest('[data-transcript-scroll]')
      return !other || other === el
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'End' && e.key !== 'Home') return
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) return
      if (isEditableShortcutTarget(e.target) || !ownsEvent(e.target)) return
      e.preventDefault()
      if (e.key === 'End') jumpBottom()
      else jumpTop()
    }
    const onCommand = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (!ownsEvent(null)) return
      if (id === 'jump-latest') jumpBottom()
      else if (id === 'jump-top') jumpTop()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('vyotiq:command', onCommand)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('vyotiq:command', onCommand)
    }
  }, [jumpBottom, jumpTop])

  return { scrollRef, contentRef, onScroll, jumpTop, jumpBottom }
}
