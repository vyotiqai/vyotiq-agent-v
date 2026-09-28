import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { isEditableShortcutTarget } from '@renderer/lib/shortcuts'

/** Within this of the bottom, a reader scrolling down picks the live run up again. */
const NEAR_BOTTOM_PX = 80
/** At the bottom, give or take sub-pixel rounding. */
const AT_BOTTOM_PX = 4
const REPORT_DELAY_MS = 150

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

/** Keys that move a scroll area up. */
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

/**
 * Scrolling for a task record.
 *
 * A record opens at its top — the needs-you card, the brief — or where you
 * left it. While a run is live it follows the growth only if you
 * are at the bottom, so reading earlier work is never yanked away: the first
 * move up (wheel, keys, the scrollbar) lets go, and coming back down to the
 * end picks the run up again. When the run you were following ends, the view
 * stays on its end, where the answer is.
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
  /** Scroll events our own `scrollTop` writes will fire, still to be seen. */
  const programmaticRef = useRef(false)
  /** A smooth jump in flight: its own scroll events are not the reader's. */
  const jumpingRef = useRef<'top' | 'bottom' | null>(null)
  const appliedTokenRef = useRef<number | null>(null)
  const reportTimerRef = useRef<number | null>(null)
  const onScrollTopChangeRef = useRef(onScrollTopChange)
  onScrollTopChangeRef.current = onScrollTopChange
  const liveRef = useRef(live)
  liveRef.current = live

  const setTop = useCallback((top: number) => {
    const el = scrollRef.current
    if (!el) return
    const before = el.scrollTop
    el.scrollTop = top
    // Only a write that moved the view fires a scroll event to skip; flagging
    // one that did not would swallow the reader's next scroll.
    if (el.scrollTop !== before) programmaticRef.current = true
    pinnedRef.current = distanceFromBottom(el) <= NEAR_BOTTOM_PX
  }, [])

  const followToEnd = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const before = el.scrollTop
    el.scrollTop = el.scrollHeight
    if (el.scrollTop !== before) programmaticRef.current = true
    pinnedRef.current = true
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

  // The run you were following ended: its answer is the last thing in the
  // record, and its finished steps just folded, so hold on to the end.
  const wasLiveRef = useRef(live)
  useLayoutEffect(() => {
    const wasLive = wasLiveRef.current
    wasLiveRef.current = live
    if (!wasLive || live || !pinnedRef.current) return
    const el = scrollRef.current
    if (!el) return
    pendingRef.current = null
    followToEnd()
  }, [live, followToEnd])

  /** The reader moved up: let go of the live run at once. */
  const letGo = useCallback(() => {
    const el = scrollRef.current
    jumpingRef.current = null
    pendingRef.current = null
    if (!el || liveRef.current || distanceFromBottom(el) > AT_BOTTOM_PX) pinnedRef.current = false
  }, [])

  // Growth — of the record or of the pane around it: finish a pending
  // restore, or keep a live run you are at the end of in view. Re-attached
  // when the record becomes ready, in case its scroll area mounted late.
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
      if (liveRef.current && pinnedRef.current && jumpingRef.current !== 'top') followToEnd()
    })
    ro.observe(content)
    ro.observe(el)
    return () => ro.disconnect()
  }, [setTop, followToEnd, ready])

  // A wheel turned up lets go before a smooth scroll has travelled far enough
  // for its scroll events to say so; a press on the scrollbar (the element
  // itself, not its content) is the reader's drag, not our jump.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) letGo()
      else jumpingRef.current = null
    }
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target === el) jumpingRef.current = null
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('pointerdown', onPointerDown)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
    }
  }, [letGo, ready])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = distanceFromBottom(el)
    if (programmaticRef.current) {
      programmaticRef.current = false
    } else if (jumpingRef.current) {
      // Our own smooth jump: done once it arrives.
      if (jumpingRef.current === 'bottom' ? distance <= AT_BOTTOM_PX : el.scrollTop <= 1) jumpingRef.current = null
    } else {
      // The reader moved: a stale saved position no longer applies.
      pendingRef.current = null
      if (distance <= AT_BOTTOM_PX) pinnedRef.current = true
      else if (distance > NEAR_BOTTOM_PX) pinnedRef.current = false
      // In between it keeps what it was: a reader easing down from far above
      // is not grabbed early, and one who let go is not grabbed back.
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
    pinnedRef.current = false
    jumpingRef.current = 'top'
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const jumpBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pendingRef.current = null
    // Following from now on: growth during the glide re-aims it at the new end.
    pinnedRef.current = true
    jumpingRef.current = 'bottom'
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  /** Whether the record is following the live run right now. */
  const isFollowing = useCallback(() => pinnedRef.current, [])

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
      if (UP_KEYS.has(e.key) && e.key !== 'Home') {
        // Arrow Up / Page Up scroll the record natively; they still let go.
        if (!e.defaultPrevented && !isEditableShortcutTarget(e.target) && ownsEvent(e.target)) letGo()
        return
      }
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
  }, [jumpBottom, jumpTop, letGo])

  return { scrollRef, contentRef, onScroll, jumpTop, jumpBottom, isFollowing }
}
