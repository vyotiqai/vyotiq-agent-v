import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import type { AgentInteractionMode } from '@shared/ipc'
import { BRIEF_CHECKS, DEFAULT_EFFORT, FOLLOW_UPS, type Segment } from './data'
import { hasContent } from './scenes'

export type Surface = 'line' | 'inline' | 'brief'
export type Pop = 'model' | 'context' | 'attach' | 'mic' | 'mention' | 'slash'
export type TakeView = 'listening' | 'inserted' | null
export type StructureView = 'working' | 'done' | null

/** One state of the composer — what a scene sets up before anything is clicked. */
export type Scene = {
  surface: Surface
  running: boolean
  segments: Segment[]
  attachments: boolean
  followUps: boolean
  take: TakeView
  structure: StructureView
  readiness: boolean
  error: boolean
  /** Dictation is set up (the mic dictates) or not (it opens "Dictate with"). */
  micReady: boolean
  /** The popover open when the scene loads. */
  pop: Pop | null
}

export type QueueEntry = { id: string; preview: string; offline: boolean }

/** What the words before the caret ask for: `@query` anywhere, `/query` at the start. */
export type Trigger = { kind: 'mention' | 'slash'; query: string; raw: string }

/** Which sample attachments are on the composer. */
export type Attached = { image: boolean; file: boolean }

type Glass = {
  /** The scene as it is now: it starts as the viewer's scene, then every click moves it on. */
  scene: Scene
  /**
   * Move the scene on. A change to the words, a take or Structure redraws the
   * field (its `rev`), keeping what was typed unless `segments` says otherwise.
   */
  patch: (next: Partial<Scene>) => void
  /** The field's generation: it remounts on each one, with the scene's words. */
  rev: number
  mode: AgentInteractionMode
  setMode: (mode: AgentInteractionMode) => void
  effortAt: number
  setEffortAt: (i: number) => void
  modelAt: number
  setModelAt: (i: number) => void
  pop: Pop | null
  /** Something to send: words in the field (as typed, not just as the scene set it up), a chip, a file. */
  filled: boolean
  setTyped: (typed: boolean) => void
  attached: Attached
  setAttached: (next: Attached) => void
  queue: QueueEntry[]
  setQueue: (next: QueueEntry[]) => void
  checks: string[]
  setChecks: (next: string[]) => void
  trigger: Trigger | null
  /** The @ or / menu follows the words: it opens on a trigger, and a closed one stays closed until the trigger changes. */
  setTrigger: (next: Trigger | null) => void
  /** The highlighted row of the open @ or / menu. */
  menuActive: number
  setMenuActive: (i: number) => void
  toggle: (pop: Pop) => void
  close: () => void
  /** The live field, and whether the next one to mount should take focus. */
  fieldRef: MutableRefObject<HTMLDivElement | null>
  wantsFocus: MutableRefObject<boolean>
  /** Structure at work: its timer, and the words it replaced (for Undo and Try again). */
  structureMemo: MutableRefObject<{ timer: number | null; before: Segment[] | null }>
  /** The frame the popovers portal into, and its scale on screen. */
  layer: HTMLElement | null
}

const Ctx = createContext<Glass | null>(null)

/** The field's words as segments: its text, and the chips it was drawn with (by `data-seg`). */
export function readSegments(root: HTMLElement, known: Segment[]): Segment[] {
  const out: Segment[] = []
  let text = ''
  const flush = (): void => {
    if (text) out.push({ type: 'text', value: text })
    text = ''
  }
  const walk = (node: Node): void => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent ?? ''
        return
      }
      if (!(child instanceof HTMLElement)) return
      const seg = child.dataset.seg === undefined ? undefined : known[Number(child.dataset.seg)]
      if (seg?.type === 'chip') {
        flush()
        out.push(seg)
        return
      }
      if (child.tagName === 'BR') {
        text += '\n'
        return
      }
      // A line Chromium wrapped in its own block starts a new line.
      if ((child.tagName === 'DIV' || child.tagName === 'P') && (text || out.length)) text += '\n'
      walk(child)
    })
  }
  walk(root)
  flush()
  return out
}

export function GlassProvider({
  scene: initial,
  layer,
  children
}: {
  scene: Scene
  layer: HTMLElement | null
  children: ReactNode
}) {
  const [scene, setScene] = useState<Scene>(initial)
  const [rev, setRev] = useState(0)
  const [mode, setMode] = useState<AgentInteractionMode>('agent')
  const [effortAt, setEffortAt] = useState(DEFAULT_EFFORT)
  const [modelAt, setModelAt] = useState(0)
  const [pop, setPop] = useState<Pop | null>(initial.pop)
  const [typed, setTyped] = useState(() => hasContent({ ...initial, attachments: false }))
  const [attached, setAttached] = useState<Attached>({ image: initial.attachments, file: initial.attachments })
  const [queue, setQueue] = useState<QueueEntry[]>(() => (initial.followUps ? FOLLOW_UPS : []))
  const [checks, setChecks] = useState<string[]>(BRIEF_CHECKS)
  const [trigger, setTriggerState] = useState<Trigger | null>(null)
  const [menuActive, setMenuActive] = useState(0)
  const dismissed = useRef<string | null>(null)
  const fieldRef = useRef<HTMLDivElement | null>(null)
  const wantsFocus = useRef(false)
  const structureMemo = useRef<{ timer: number | null; before: Segment[] | null }>({ timer: null, before: null })
  useEffect(() => {
    const memo = structureMemo.current
    return () => {
      if (memo.timer !== null) window.clearTimeout(memo.timer)
    }
  }, [])
  const sceneRef = useRef(scene)
  sceneRef.current = scene

  const filled = typed || attached.image || attached.file

  const patch = useCallback((next: Partial<Scene>) => {
    const cur = sceneRef.current
    const redraw = 'segments' in next || 'take' in next || 'structure' in next || 'surface' in next
    let merged: Scene = { ...cur, ...next }
    if (redraw) {
      // Keep what was typed: read it back unless the change brings its own words.
      // A live take's words are not typed ones, so they are never read back.
      const el = fieldRef.current
      if (!('segments' in next) && el && cur.take !== 'listening') {
        merged = { ...merged, segments: readSegments(el, cur.segments) }
        // The take's tinted words are now plain words, so the take is over.
        if (cur.take === 'inserted' && !('take' in next)) merged = { ...merged, take: null }
      }
      setRev((r) => r + 1)
      setTyped(hasContent({ ...merged, attachments: false }))
      wantsFocus.current = true
    }
    if ('attachments' in next) setAttached({ image: Boolean(next.attachments), file: Boolean(next.attachments) })
    sceneRef.current = merged
    setScene(merged)
  }, [])

  const setTrigger = useCallback((next: Trigger | null) => {
    setTriggerState(next)
    setMenuActive(0)
    if (!next) {
      dismissed.current = null
      setPop((cur) => (cur === 'mention' || cur === 'slash' ? null : cur))
      return
    }
    if (dismissed.current === `${next.kind}:${next.raw}`) return
    setPop(next.kind)
  }, [])

  const toggle = useCallback((next: Pop) => setPop((cur) => (cur === next ? null : next)), [])
  const close = useCallback(() => {
    setPop((cur) => {
      // Closing the @ or / menu by hand keeps it closed until the words change.
      if ((cur === 'mention' || cur === 'slash') && trigger) dismissed.current = `${trigger.kind}:${trigger.raw}`
      return null
    })
  }, [trigger])

  const value = useMemo(
    () => ({
      scene,
      patch,
      rev,
      mode,
      setMode,
      effortAt,
      setEffortAt,
      modelAt,
      setModelAt,
      pop,
      filled,
      setTyped,
      attached,
      setAttached,
      queue,
      setQueue,
      checks,
      setChecks,
      trigger,
      setTrigger,
      menuActive,
      setMenuActive,
      toggle,
      close,
      fieldRef,
      wantsFocus,
      structureMemo,
      layer
    }),
    [scene, patch, rev, mode, effortAt, modelAt, pop, filled, attached, queue, checks, trigger, setTrigger, menuActive, toggle, close, layer]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useGlass(): Glass {
  const v = useContext(Ctx)
  if (!v) throw new Error('useGlass outside GlassProvider')
  return v
}

/** Where an anchor sits in the frame's own (unscaled) pixels. */
type Rect = { left: number; right: number; top: number; bottom: number; width: number; frameW: number; frameH: number }

function useAnchorRect(anchor: RefObject<HTMLElement | null>, layer: HTMLElement | null, open: boolean): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null)
  useLayoutEffect(() => {
    if (!open || !layer || !anchor.current) {
      setRect(null)
      return undefined
    }
    const el = anchor.current
    const clear = el.closest<HTMLElement>('[data-gx-clear-shell]')
    const measure = (): void => {
      if (!el.isConnected) return
      const f = layer.getBoundingClientRect()
      const scale = f.width / Math.max(1, layer.offsetWidth)
      const a = el.getBoundingClientRect()
      // In B every popover clears the pill — up past its top, down past its bottom — whether its
      // trigger is in the pill or on the rail. In A (the app) it opens from the trigger, over the box.
      const shellEl = clear?.querySelector('[data-composer-shell]')
      const shell = shellEl?.getBoundingClientRect()
      const top = shell ? Math.min(a.top, shell.top) : a.top
      const bottom = shell ? Math.max(a.bottom, shell.bottom) : a.bottom
      // A button in the pill (attach, the mic) opens a menu on the pill's own outer edge, not 14px in;
      // the @ and / menus anchor to the words, so they keep the text edge.
      const onShellEdge = Boolean(shell && shellEl?.contains(el) && el.matches('button'))
      const next: Rect = {
        left: ((onShellEdge && shell ? shell.left : a.left) - f.left) / scale,
        right: ((onShellEdge && shell ? shell.right : a.right) - f.left) / scale,
        top: (top - f.top) / scale,
        bottom: (bottom - f.top) / scale,
        width: a.width / scale,
        frameW: layer.offsetWidth,
        frameH: layer.offsetHeight
      }
      setRect((cur) =>
        cur && (Object.keys(next) as (keyof Rect)[]).every((k) => Math.abs(cur[k] - next[k]) < 0.5) ? cur : next
      )
    }
    measure()
    // The anchor moves without the frame resizing: B's rail unfolds under the pill and lifts it,
    // the field grows as words wrap. Follow the composer as well as the frame.
    const ro = new ResizeObserver(measure)
    ro.observe(layer)
    ro.observe(el)
    const column = el.closest<HTMLElement>('[data-composer-column], [data-gx-clear-shell], [data-composer-inline], [data-brief]')
    if (column) ro.observe(column)
    return () => ro.disconnect()
  }, [anchor, layer, open])
  return rect
}

/** useDropdownMenu's gap and composerDropdownLayout's pad. */
const GAP = 6
const PAD = 8

const FOCUSABLE = '[role="menuitem"], input, button:not([disabled]), [tabindex="0"]'

/**
 * A popover opening upward from its anchor, portalled to the frame — outside
 * the glass box, so its own blur sees the backdrop (a backdrop-filter inside
 * another only sees its parent). Widths and alignment are the app's:
 * `start` puts its left on the anchor's left, `end` its right on the
 * anchor's right, `anchor` tracks the anchor's width between min and max.
 *
 * Focus is the app's too: opened from a focused trigger, the panel takes
 * focus (a menu its first row, a dialog its first field); Esc, a pick or
 * focus leaving it hands focus back to the trigger. The @ and / menus are
 * driven from the field and never take it.
 */
export function Popover({
  anchor,
  open,
  align,
  width,
  minWidth,
  maxWidth,
  children,
  className,
  label,
  role = 'dialog'
}: {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  align: 'start' | 'end'
  width?: number
  minWidth?: number
  maxWidth?: number
  children: ReactNode
  className?: string
  label: string
  role?: 'dialog' | 'menu' | 'listbox'
}) {
  const { layer, close } = useGlass()
  const rect = useAnchorRect(anchor, layer, open)
  const panel = useRef<HTMLDivElement>(null)
  const placed = Boolean(open && layer && rect)
  // useDropdownMenu: a press outside the panel and its trigger closes it, and so does Esc.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node | null
      if (!t || panel.current?.contains(t) || anchor.current?.contains(t)) return
      close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const inside = panel.current?.contains(document.activeElement)
      close()
      if (inside) anchor.current?.focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, anchor, close])
  // Opened from a focused trigger: the panel takes focus, as ActionMenu and the pickers do.
  useEffect(() => {
    if (!placed) return
    if (document.activeElement !== anchor.current) return
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
  }, [placed, anchor])
  if (!open || !layer || !rect) return null
  const w =
    width ??
    Math.min(maxWidth ?? 420, Math.max(minWidth ?? 260, Math.round(rect.width)))
  const wanted = align === 'start' ? rect.left : rect.right - w
  const left = Math.max(PAD, Math.min(wanted, rect.frameW - w - PAD))
  const above = rect.top - GAP - PAD
  const below = rect.frameH - rect.bottom - GAP - PAD
  // Up by default; down when the composer sits near the top (the brief) and there is more room there.
  const down = above < 240 && below > above
  // composerDropdownLayout: at most 70% of the window, never under the panel's minimum.
  const maxHeight = Math.min(Math.max(180, down ? below : above), Math.round(rect.frameH * 0.7))
  const place = down ? { top: rect.bottom + GAP } : { bottom: rect.frameH - rect.top + GAP }
  return createPortal(
    <div
      ref={panel}
      role={role}
      aria-label={label}
      className={[
        'gx-pop absolute z-30 flex flex-col overflow-hidden animate-menu-in',
        down ? 'origin-top' : 'origin-bottom',
        className
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ left, width: w, maxHeight, ...place }}
      onKeyDown={(e) => {
        // A menu's rows move with the arrows, wrapping, as ActionMenu's do.
        if (role !== 'menu' || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End')) return
        const rows = [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        if (!rows.length) return
        e.preventDefault()
        const at = rows.indexOf(document.activeElement as HTMLElement)
        const next =
          e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
        rows[next]?.focus()
      }}
      onBlur={(e) => {
        // Tabbing out of the panel closes it, unless focus went back to its trigger.
        const to = e.relatedTarget as Node | null
        if (!to || panel.current?.contains(to) || anchor.current?.contains(to)) return
        close()
      }}
    >
      {children}
    </div>,
    layer
  )
}
