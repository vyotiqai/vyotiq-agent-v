/** Minimum chat column width reserved when clamping the side dock. */
export const CHAT_COLUMN_MIN_USABLE_PX = 280

/** Absolute ceiling on simultaneously visible chat panes, even on ultrawide viewports. */
export const MAX_CHAT_PANES_HARD_CAP = 6

/**
 * Default / clamp bounds for the inspector (px). 452 is the redesign's width:
 * beside the 264px navigator it leaves a 724px record in a 1440px window.
 */
export const DOCK_WIDTH_DEFAULT_PX = 452
export const DOCK_WIDTH_MIN_PX = 280
export const DOCK_WIDTH_MAX_PX = 960

/** localStorage key for whether the inspector is shown (it is, by default). */
export const INSPECTOR_OPEN_KEY = 'vyotiq.inspectorOpen'

/** localStorage key for the inspector taking the whole work area. */
export const INSPECTOR_EXPANDED_KEY = 'vyotiq.inspectorExpanded'

/** localStorage key for the inspector's width in px. */
export const DOCK_WIDTH_KEY = 'vyotiq.dockWidth'

/** Auto-grow cap for the instruction field (280px). */
export const COMPOSER_TEXTAREA_MAX_CLASS = 'max-h-[280px]'

/** Ask-question gate — quiet panel, not bordered tool-card chrome. */
/**
 * The needs-you frame: the one accent block in a record. An accent outline,
 * a tinted 32px header, then the ask. Shared by questions and approvals.
 */
export const QUESTION_GATE_SURFACE = 'overflow-hidden rounded-lg border border-accent bg-bg'
export const QUESTION_GATE_HEADER = 'flex h-8 items-center gap-2 bg-accent-soft px-3 text-xs'
export const QUESTION_GATE_BODY = 'px-3 py-3'
export const QUESTION_GATE_FOOTER = 'flex items-center gap-1.5 px-3 pb-3'

/** Collapsed tool body height before fade mask (virtualizer estimate). */
export const TOOL_BODY_CLAMP_PX = 168

/**
 * Max source lines rendered for read / memory_read bodies in the transcript.
 * Keeps ~TOOL_BODY_CLAMP_PX at 11px / 1.6 leading; full file stays model-side.
 */
export const READ_BODY_PREVIEW_LINES = 8

/** Cap terminal tool output so streaming cannot inflate the record. */
export const TOOL_TERMINAL_VIEWPORT =
  'max-h-[min(12rem,28vh)] overflow-y-auto overscroll-contain'

/** Standard inner padding for tool body content. */
export const TOOL_BODY_PAD = 'px-3 py-2'

/** Inner region inside a tool body. */
export const TOOL_BODY_INNER = 'px-3 py-1.5'

/** Flow with parent scroll — no nested max-height scrollport; pr-5 clears disclosure chrome. */
export const TOOL_BODY_FLOW = 'overflow-visible pr-5'

/** Nested scrollport for browser snapshot refs / page text (keeps SERP dumps from flooding the timeline). */
export const TOOL_SNAPSHOT_SCROLL =
  'max-h-[min(12rem,28vh)] overflow-y-auto overscroll-contain'

/** Family shell for terminal output inside the record (not a bordered card of its own). */
export const TOOL_FAMILY_TERMINAL = 'overflow-hidden'

/**
 * The navigator column (it replaced the sidebar; the names stay so the pane
 * capacity maths keeps one vocabulary). 264 is the redesign's width.
 */
export const SIDEBAR_WIDTH_PX = 264
export const SIDEBAR_WIDTH_MIN_PX = 220
export const SIDEBAR_WIDTH_MAX_PX = 420
export const TITLE_BAR_HEIGHT = 'h-9'

/** True when the shell draws custom min/max/close (Win/Linux; also jsdom fallback). */
export function showsWindowControls(
  platform: string | undefined = typeof window !== 'undefined'
    ? window.vyotiq?.platform
    : undefined
): boolean {
  return platform === 'win32' || platform === 'linux' || !platform
}

/**
 * Hover fills — three weights, chosen by what sits under the pointer.
 *
 * These had grown into eight ad-hoc opacities (25/30/40/50/55/60/70 plus a bare
 * `bg-surface`) for one affordance, which is the same as having none: a reader
 * cannot learn what a heavier fill means, because it does not mean anything.
 * Pick by role, never by how a particular row happens to look.
 */
/**
 * A row in a scrollable list. Full `bg-surface`: the redesign's panels sit on
 * `bg-bg`, and `surface` is already only a step off it, so a fractional fill
 * vanished on four of the ten palettes.
 */
export const ROW_HOVER = 'hover:bg-surface'
/**
 * A discrete control: button, nav item, tab, icon target. Full strength,
 * because that is what `Button`/`IconButton`'s `ghost` variants already use —
 * a control that dims itself below them only looks broken next to one.
 */
export const CONTROL_HOVER = 'hover:bg-surface'
/**
 * Either of the above where the element already sits on `bg-surface` — there a
 * `bg-surface` fill is invisible, so the step has to come off `surface-2`, the
 * way the `subtle` button variants do. One weight covers both roles: the
 * contrast is already doing the work.
 */
export const HOVER_ON_SURFACE = 'hover:bg-surface-2'

/**
 * Borders — two weights, and the opacity is the whole distinction.
 *
 * Full-strength `border-border` **outlines a thing** (panel, card, menu, input)
 * and is the house default at ~240 call sites. {@link BORDER_DIVIDER}
 * **separates two things inside it** (a row from the next, a header from a
 * body). Anything else invents a weight that has to be re-learned on sight.
 *
 * {@link DIVIDER_FILL} is the same grey as a background rather than a border:
 * a rule drawn as a 1px element, a progress track, a zero-value chart bar.
 * One value covers all of them — "quiet grey" is a single idea, and the
 * /40-vs-/50-vs-full spread these had carried no meaning to read.
 */
export const BORDER_DIVIDER = 'border-border/60'
export const DIVIDER_FILL = 'bg-border'

/** The one fill for "this is the one you're on": a selected row, tab or place. */
export const SELECTED = 'bg-surface-2 text-fg-strong'

/**
 * Section label: caps, tracked, quiet. One style everywhere — Home, Settings,
 * the record. Needs you included: its rows carry the accent, so its label stays
 * as quiet as the rest, which is how the approved mockup renders it.
 */
export const SECTION_LABEL = 'text-caption font-semibold uppercase tracking-[var(--vy-tracking-caps)] text-tertiary'

/** Numbers that line up: costs, tokens, durations, counts. */
export const NUM = 'font-mono tnum text-caption'

/** A page's title. */
export const PAGE_TITLE = 'text-title font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong'

/** The record column: one content edge, a readable measure. No label gutter. */
export const RECORD_MAX = 'max-w-[780px]'

/** The instruction line: the record's own edge, so the two read as one column. */
export const COMPOSER_MAX = 'max-w-[780px]'

/**
 * The 8px the record's scroll reserves with `[scrollbar-gutter:stable]`. The
 * composer is not a scrollport, so it reserves the same width as padding —
 * without it the composer's column centres on the pane's offset box and sits
 * ~4px right of the record's, which centres on its client box.
 */
export const COMPOSER_GUTTER = 'pr-2'

/**
 * The box is the record's card — the brief and the step rows bleed 8px past
 * the column's 16px padding on each side, so the composer's box takes the
 * same bleed and lands on the record's card edge instead of 12px inside it.
 */
export const COMPOSER_BOX_BLEED = '-mx-2'

export { RUN_LIST_CAP } from '@shared/domain/runs'

/** localStorage key for the navigator being hidden (Ctrl B). */
export const SIDEBAR_COLLAPSED_KEY = 'vyotiq.sidebarCollapsed'

/**
 * localStorage key for the navigator's width in px. A new key: widths saved
 * for the old 248px sidebar would otherwise pin the navigator below its size.
 */
export const SIDEBAR_WIDTH_KEY = 'vyotiq.navigatorWidth'

/** localStorage key for the inspector's last tab. */
export const RIGHT_PANEL_KEY = 'vyotiq.rightPanel'

export const CHAT_RIGHT_PANEL_IDS = [
  'files',
  'browser',
  'terminal',
  'changes',
  'plan',
  'pr'
] as const

export type ChatRightPanelId = (typeof CHAT_RIGHT_PANEL_IDS)[number]

export function isChatRightPanelId(value: string | null | undefined): value is ChatRightPanelId {
  return (
    value != null && (CHAT_RIGHT_PANEL_IDS as readonly string[]).includes(value)
  )
}

/** Shared content shell inside the right dock (parent owns CHAT_RIGHT_PANEL + tab bar). */
export const CHAT_RIGHT_PANEL_BODY =
  'flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden'

/** Read live sidebar width for pane-capacity math (localStorage-backed). */
export function readSidebarWidthPxForCapacity(): number {
  if (typeof window === 'undefined') return SIDEBAR_WIDTH_MIN_PX
  try {
    // usePersistedBoolean writes '1'/'0'; 'true' is the older spelling. A
    // hidden navigator takes no width at all — there is no rail behind it.
    const collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY)
    if (collapsed === '1' || collapsed === 'true') return 0
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    const n = raw ? Number(raw) : SIDEBAR_WIDTH_PX
    const w = Number.isFinite(n) ? n : SIDEBAR_WIDTH_PX
    return clampSidebarWidthPx(w)
  } catch {
    return SIDEBAR_WIDTH_PX
  }
}

/** Chrome width subtracted before counting how many panes fit. */
export function paneCapacityReservedPx(options?: {
  sidebarWidthPx?: number
  dockWidthPx?: number
  dockOpen?: boolean
}): number {
  const sidebar = options?.sidebarWidthPx ?? readSidebarWidthPxForCapacity()
  const dockOpen = options?.dockOpen && (options.dockWidthPx ?? 0) > 0
  const dock = dockOpen ? options!.dockWidthPx! : 0
  return sidebar + dock
}

/**
 * Clamp the inspector's width so usable task column(s) remain beside the
 * navigator. With multiple panes, reserves {@link CHAT_COLUMN_MIN_USABLE_PX} per pane.
 */
export function clampDockWidthPx(
  width: number,
  viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280,
  options?: { paneCount?: number; sidebarWidthPx?: number }
): number {
  const paneCount = Math.max(1, options?.paneCount ?? 1)
  const sidebar = options?.sidebarWidthPx ?? readSidebarWidthPxForCapacity()
  const reservedChrome = paneCount * CHAT_COLUMN_MIN_USABLE_PX + sidebar
  const maxByViewport = Math.max(
    DOCK_WIDTH_MIN_PX,
    Math.min(DOCK_WIDTH_MAX_PX, viewportWidth - reservedChrome)
  )
  return Math.min(maxByViewport, Math.max(DOCK_WIDTH_MIN_PX, Math.round(width)))
}

/** Clamp expanded sidebar width so a usable chat column remains. */
export function clampSidebarWidthPx(
  width: number,
  viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
): number {
  const maxByViewport = Math.max(
    SIDEBAR_WIDTH_MIN_PX,
    Math.min(SIDEBAR_WIDTH_MAX_PX, viewportWidth - CHAT_COLUMN_MIN_USABLE_PX)
  )
  return Math.min(maxByViewport, Math.max(SIDEBAR_WIDTH_MIN_PX, Math.round(width)))
}
