/** Shared horizontal gutter for chat column surfaces. */
export const CHAT_GUTTER = 'px-4 sm:px-5'

/**
 * Top inset for chat stage surfaces that carry no sticky child.
 *
 * The transcript scrollport must NOT use this: Chromium insets a sticky child's
 * `top: 0` by the scroller's own `padding-top`, so the pinned turn prompt would
 * rest 16px below the visible edge and rows would scroll through the strip above
 * it. The transcript rides {@link CHAT_STAGE_TOP_SPACER} instead.
 */
export const CHAT_STAGE_TOP_INSET = 'pt-4'

/**
 * Scrolled equivalent of {@link CHAT_STAGE_TOP_INSET} (same 16px) for the
 * transcript: a leading spacer row rather than scrollport padding, so the
 * pinned turn prompt can pin flush with the scrollport's top edge.
 */
export const CHAT_STAGE_TOP_SPACER = 'h-4'

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

/** Shared max width for chat column content (messages + composer). */
export const CHAT_COLUMN_MAX = 'max-w-[840px]'

/** Centered chat column — transcript and composer share this wrapper. */
export const CHAT_COLUMN = `mx-auto w-full ${CHAT_COLUMN_MAX}`

/**
 * Floating edge-to-edge composer dock — overlays the chat stage bottom.
 * Anchors to the nearest positioned ancestor (`[data-chat-stage]`); the shell
 * keeps `pointer-events-auto` so the wrapper never blocks the transcript, not
 * even under {@link COMPOSER_DOCK_COVER}'s fade.
 */
export const COMPOSER_FLOAT_DOCK = 'pointer-events-none absolute inset-x-0 bottom-0 z-20'

/**
 * Cover on the dock's centered column. `pb-2` is the gap under the shell, so
 * its rounded border never reads as clipped by the window edge; `pt-4` is the
 * strip rows fade out across on their way under the shell (the `1rem` in
 * `vy-composer-dock-cover`). Both sit inside the measured dock height, so the
 * transcript's reserve covers them and the last row rests above the fade.
 */
export const COMPOSER_DOCK_COVER = 'vy-composer-dock-cover pt-4 pb-2'

/**
 * Scroll-clipped dock body — reserves the same scrollbar gutter as the
 * transcript scrollport so the centered composer column lines up exactly with
 * the transcript column under classic (space-reserving) scrollbars.
 */
export const COMPOSER_FLOAT_BODY =
  'w-full overflow-x-hidden overflow-y-hidden [scrollbar-gutter:stable]'

/**
 * CSS variable the floating composer publishes its measured height to (on the
 * chat stage root); MessageList reserves that height so the last transcript
 * row can scroll fully clear of the bar. The height includes the dock cover's
 * fade, which doubles as the clearance above the shell.
 */
export const COMPOSER_DOCK_RESERVE_VAR = '--vy-composer-dock-height'

/**
 * Extra bottom reserve while a run is live so streaming rows stay clear of a
 * reserved dock; idle chats keep only the dock cover's fade.
 */
export const COMPOSER_DOCK_LIVE_CLEARANCE_PX = 16

/** Fallback dock reserve when measured height is not yet available (`8rem`). */
export const COMPOSER_DOCK_FALLBACK_PX = 128

/** Composer textarea auto-grow cap — keep in sync with `COMPOSER_TEXTAREA_MAX_CLASS`. */
export const COMPOSER_TEXTAREA_MAX_PX = 280

/** Tailwind max-height matching `COMPOSER_TEXTAREA_MAX_PX`. */
export const COMPOSER_TEXTAREA_MAX_CLASS = 'max-h-[280px]'

/** Shared max width for marketplace content column. */
export const MARKETPLACE_COLUMN_MAX = 'max-w-[1040px]'

/** Centered marketplace column. */
export const MARKETPLACE_COLUMN = `mx-auto w-full ${MARKETPLACE_COLUMN_MAX}`

/**
 * Teammates rail — the task inbox entry plus the roster, beside the detail
 * pane. Fixed rather than fluid: it holds an avatar, a name and one badge, and
 * a fluid track would stretch that to half the window on a wide display.
 */
export const TEAMMATES_RAIL_WIDTH = 'w-[264px]'

/** Content column inside the teammates detail pane. */
export const TEAMMATES_DETAIL_COLUMN = 'w-full max-w-[720px]'

/**
 * Vertical rhythm. Applied as padding on each row rather than flex gap so
 * spacing stays consistent across the transcript.
 */
export const TRANSCRIPT_ROW_GAP = 'pb-2.5'

/** Extra breathing room around tool activity and reasoning rows. */
export const TRANSCRIPT_WORK_ROW_GAP = 'pb-4'

/**
 * Tight gap between interleaved thinking ↔ activity disclosures so Thought /
 * tool pairs do not stack a full work gap on every step.
 */
export const TRANSCRIPT_WORK_PAIR_GAP = 'pb-1.5'

/** Lead-in above a user prompt that opens a new turn. */
export const TRANSCRIPT_TURN_GAP = 'pt-8'

/**
 * User prompt typography — the prompt is the heading of its turn. It steps up
 * from the 13px body to the heading scale with tighter tracking and the strong
 * foreground.
 * Keep in sync with the `[data-user-prompt] .markdown-body` rule in styles.css,
 * which has to restate this because MarkdownContent styles its own root.
 */
export const USER_PROMPT_TEXT =
  'text-heading leading-normal tracking-[var(--vy-tracking-tight)] text-fg-strong [overflow-wrap:anywhere]'

/**
 * User prompt block — its border and inset define a readable bubble without a
 * fill or shadow. The pinned turn stack in MessageList carries scroll-through
 * occlusion.
 */
export const USER_PROMPT_SURFACE = `w-full rounded-[var(--vy-radius-xl)] border border-border px-3 py-2 ${USER_PROMPT_TEXT}`

/**
 * Horizontal inset of a row set under the prompt bubble (the tasks band): the
 * bubble's own border width and padding, with the border left transparent, so
 * the row starts on the prompt text's left edge and ends on its right one.
 */
export const USER_PROMPT_INSET = 'border-x border-transparent px-3'

/**
 * Lines of a user prompt shown before it folds behind Show more. Every turn
 * prompt pins while its turn is on screen, so this is also how much of the
 * work beneath the pinned stack covers.
 */
export const USER_PROMPT_CLAMP_LINES = 2

/**
 * Vertical rhythm of the turn-prompt stack (prompt + tasks band). The bottom
 * padding doubles as the pinned cover's fade (`vy-turn-prompt-cover` in
 * styles.css), so the two change together.
 */
export const TURN_PROMPT_STACK = 'pt-2.5 pb-4'

/**
 * Pinned state of {@link TURN_PROMPT_STACK}: flush with the scrollport's top
 * edge (see {@link CHAT_STAGE_TOP_SPACER}) over a page-colored cover. Rows
 * scrolling beneath dissolve across its bottom padding instead of meeting a
 * hard edge; nothing shows through behind the prompt or the tasks band.
 */
export const TURN_PROMPT_STACK_PINNED = 'sticky top-0 z-sticky vy-turn-prompt-cover'

/** Quiet activity row — no fill, no border. */
export const ACTIVITY_ROW = 'text-xs tracking-[var(--vy-tracking)]'

/** One line of a disclosure list: label, detail, trailing meta. */
export const DISCLOSURE_ROW =
  'flex min-w-0 items-center gap-1.5 rounded-sm py-1.5 text-xs vy-transition hover:opacity-80'

/**
 * Disclosure chevron — hidden until the row is hovered or focused.
 * Pair with `group` on the disclosure control; add rotate when expanded.
 */
export const DISCLOSURE_CHEVRON =
  'shrink-0 text-tertiary opacity-0 vy-transition group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100'

/** Tool card chrome — bordered terminal / edit ToolCard surfaces. */
export const TOOL_CARD_SURFACE =
  'overflow-hidden rounded-lg border border-border'
export const TOOL_CARD_HEADER = 'px-3 py-2 text-xs'
/** Body content owns its own padding so a diff can run edge to edge. */
export const TOOL_CARD_BODY = 'overflow-hidden border-t border-border bg-surface'

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

/** Minimum first-paint estimate for an expanded multi-tool group. */
export const TOOL_GROUP_LIST_ESTIMATE_MIN_PX = 192

/**
 * Cap terminal tool output so streaming cannot inflate the transcript.
 * Keep in sync with TOOL_TERMINAL_VIEWPORT_MAX_PX for virtualizer estimates.
 */
export const TOOL_TERMINAL_VIEWPORT =
  'max-h-[min(12rem,28vh)] overflow-y-auto overscroll-contain'

/** Pixel ceiling matching TOOL_TERMINAL_VIEWPORT (12rem @ 16px). */
export const TOOL_TERMINAL_VIEWPORT_MAX_PX = 192

/** Standard inner padding for tool body content. */
export const TOOL_BODY_PAD = 'px-3 py-2'

/** Inner region inside a tool body. */
export const TOOL_BODY_INNER = 'px-3 py-1.5'

/** Flow with parent scroll — no nested max-height scrollport; pr-5 clears disclosure chrome. */
export const TOOL_BODY_FLOW = 'overflow-visible pr-5'

/** Nested scrollport for browser snapshot refs / page text (keeps SERP dumps from flooding the timeline). */
export const TOOL_SNAPSHOT_SCROLL =
  'max-h-[min(12rem,28vh)] overflow-y-auto overscroll-contain'

/** Family shells — compact todo / delete / read-only terminal (not bordered cards). */
export const TOOL_FAMILY_TERMINAL = 'overflow-hidden'
export const TOOL_FAMILY_TODO = 'rounded-md'
export const TOOL_FAMILY_DELETE = 'border-l-2 border-danger/50 pl-2'

/** Subtle surface shared by the in-flow docked composer. */
export const FLOATING_CHROME = 'vy-chrome bg-[var(--vy-chrome-surface)] motion-reduce:animate-none'

/**
 * The navigator column (it replaced the sidebar; the names stay so the pane
 * capacity maths keeps one vocabulary). 264 is the redesign's width.
 */
export const SIDEBAR_WIDTH_PX = 264
export const SIDEBAR_WIDTH_MIN_PX = 220
export const SIDEBAR_WIDTH_MAX_PX = 420
export const TITLE_BAR_HEIGHT = 'h-9'
export const TITLE_BAR_HEIGHT_PX = 36

/** True when the shell draws custom min/max/close (Win/Linux; also jsdom fallback). */
export function showsWindowControls(
  platform: string | undefined = typeof window !== 'undefined'
    ? window.vyotiq?.platform
    : undefined
): boolean {
  return platform === 'win32' || platform === 'linux' || !platform
}

/** Transcript scrollport — floating tasks use `@transcript/…` to sit beside the Plan rail. */
export const TRANSCRIPT_CONTAINER = '@container/transcript'

/** Quiet micro copy — dense panels, git chrome, dock toolbars. */
export const MICRO_LABEL =
  'text-caption font-medium tracking-[var(--vy-tracking-tight)] text-muted'

/** Uppercase section labels in composer dropdowns and tool bodies. */
export const MICRO_LABEL_CAPS =
  'text-2xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-secondary'

/** Filled ring active state — sidebar footer nav, dock tabs, marketplace tabs. */
export const SIDEBAR_NAV_ACTIVE =
  'bg-surface text-fg-strong ring-1 ring-inset ring-border/50'

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

/** Outlines a thing: panel, input, card, menu. Named so the pair reads as a pair. */
export const BORDER = 'border-border'

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
