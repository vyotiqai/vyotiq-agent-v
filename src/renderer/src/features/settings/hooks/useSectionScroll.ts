import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SETTINGS_REVEAL_EVENT } from '../settingsSearchIndex'
import type { SettingsSection } from '../types'

/** The attribute each section's block in the column carries, valued with its id. */
export const SECTION_ANCHOR_ATTRIBUTE = 'data-settings-anchor'

/**
 * How far below the column's top edge a section's top may sit and still be
 * the section in view — a heading that has just arrived counts.
 */
const SPY_OFFSET = 48

/** How far beyond the visible column a section mounts, so it is ready before it shows. */
const MOUNT_MARGIN = '400px 0px'

/** What ends a jump's hold on its section: the user taking the scroll over. */
const RELEASE_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'focusin', SETTINGS_REVEAL_EVENT] as const

function blocks(box: HTMLElement): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(`[${SECTION_ANCHOR_ATTRIBUTE}]`)]
}

/**
 * Settings is one scrolling column; this keeps the section the app thinks is
 * open and the one on screen the same thing, both ways.
 *
 * - `goTo` jumps a section's top to the column's top. The section holds that
 *   place while the ones around it mount and settle (their real height is
 *   not known until they do), until the user scrolls, clicks or types.
 * - Scrolling reports the section in view through `setSection`, so the index,
 *   the header and the app's own record of it follow.
 * - A `section` that changes from outside (a deep link, the palette, a row's
 *   "Add key") is a jump to it.
 * - Sections mount as they come near the visible column and stay mounted:
 *   several fetch or scan when they mount (Storage measures the disk,
 *   Voice reads its models, Diagnostics its logs), and opening Settings must
 *   not start all of them. Without IntersectionObserver only the sections
 *   jumped to mount.
 */
export function useSectionScroll(section: SettingsSection, setSection: (section: SettingsSection) => void) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(section)
  const [mounted, setMounted] = useState<ReadonlySet<SettingsSection>>(() => new Set([section]))
  const [jumps, setJumps] = useState(0)
  /** The section last reported, so a `section` the hook did not set reads as a jump. */
  const known = useRef(section)
  /** The section a jump is holding at the top, until the user scrolls. */
  const pinned = useRef<SettingsSection | null>(section)
  const setSectionRef = useRef(setSection)
  setSectionRef.current = setSection

  const settle = useCallback((id: SettingsSection): void => {
    setActive(id)
    if (known.current === id) return
    known.current = id
    setSectionRef.current(id)
  }, [])

  const align = useCallback((id: SettingsSection): void => {
    const box = scrollerRef.current
    const el = box?.querySelector<HTMLElement>(`[${SECTION_ANCHOR_ATTRIBUTE}="${id}"]`)
    if (!box || !el) return
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top
    if (Math.abs(delta) >= 1) box.scrollTop += delta
  }, [])

  const goTo = useCallback(
    (id: SettingsSection): void => {
      pinned.current = id
      settle(id)
      setMounted((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
      setJumps((n) => n + 1)
    },
    [settle]
  )

  // A section named from outside is somewhere to go.
  useLayoutEffect(() => {
    if (section !== known.current) goTo(section)
  }, [section, goTo])

  // Land the jump once its section is in the DOM, and again as neighbours mount.
  useLayoutEffect(() => {
    if (pinned.current) align(pinned.current)
  }, [jumps, mounted, align])

  // Sections settle after they mount (a list loads, a scan reports); hold the
  // jumped-to one in place while they do.
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(() => {
      if (pinned.current) align(pinned.current)
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [align])

  useEffect(() => {
    const box = scrollerRef.current
    if (!box) return undefined
    const release = (): void => {
      pinned.current = null
    }
    for (const type of RELEASE_EVENTS) box.addEventListener(type, release, { passive: true })
    return () => {
      for (const type of RELEASE_EVENTS) box.removeEventListener(type, release)
    }
  }, [])

  useEffect(() => {
    const box = scrollerRef.current
    if (!box || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        const near = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => entry.target.getAttribute(SECTION_ANCHOR_ATTRIBUTE) as SettingsSection | null)
          .filter((id): id is SettingsSection => id !== null)
        if (near.length === 0) return
        setMounted((prev) => (near.every((id) => prev.has(id)) ? prev : new Set([...prev, ...near])))
      },
      { root: box, rootMargin: MOUNT_MARGIN }
    )
    for (const el of blocks(box)) observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const frame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const onScroll = useCallback((): void => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const box = scrollerRef.current
      if (!box || pinned.current) return
      const all = blocks(box)
      const top = box.getBoundingClientRect().top + SPY_OFFSET
      const atEnd = box.scrollTop > 0 && box.scrollTop + box.clientHeight >= box.scrollHeight - 2
      const current = atEnd ? all.at(-1) : (all.filter((el) => el.getBoundingClientRect().top <= top).at(-1) ?? all[0])
      const id = current?.getAttribute(SECTION_ANCHOR_ATTRIBUTE) as SettingsSection | null | undefined
      if (id) settle(id)
    })
  }, [settle])

  return { scrollerRef, contentRef, active, mounted, goTo, onScroll }
}
