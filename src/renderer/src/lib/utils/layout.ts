/** Shared horizontal gutter for chat column surfaces. */
export const CHAT_GUTTER = 'px-4 sm:px-5'

/** Settings/marketplace body gutter — matches {@link CHAT_GUTTER}. */
export const SETTINGS_GUTTER = CHAT_GUTTER

/**
 * Horizontal inset for the docked chat stage (transcript only — the composer
 * is floating edge-to-edge). Left matches {@link CHAT_GUTTER}; right clears the
 * floating side rail (`w-10`) so content never sits under the icon strip while
 * the scrollbar stays edge-flush.
 */
export const CHAT_STAGE_INSET = 'pl-4 pr-10 sm:pl-5'

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

/**
 * Top inset for a chat-stage row that has to sit clear of the title-bar band —
 * {@link TITLE_BAR_HEIGHT_PX} plus the same 8px lead-in a banner normally gets.
 *
 * Content drops below the band rather than claiming it: a claim would hand the
 * strip to the main column and take away the only window-drag handle the plain
 * transcript has.
 */
export const CHAT_STAGE_TOP_BAND_INSET = 'pt-11'

/**
 * Top edge of the floating chat side rail.
 *
 * The rail is pinned to the top-right corner — the corner the Windows/Linux
 * caption buttons own — so it must clear the whole title bar
 * ({@link TITLE_BAR_HEIGHT_PX}), not just the stage's 16px
 * ({@link CHAT_STAGE_TOP_INSET}). At `pt-4` the Files button started 18px down
 * while Close owned the top 36px, so Close covered two thirds of it: the strip
 * read as colliding with the window controls and most of Files was unclickable.
 * `top-10` leaves the 36px bar plus a 4px gap.
 */
export const CHAT_SIDE_RAIL_TOP_INSET = 'top-10'

/** Width of the floating chat side rail (icon strip) in pixels (`w-10`). */
export const CHAT_SIDE_RAIL_WIDTH_PX = 40

/** Width of the floating chat side rail (icon strip). */
export const CHAT_SIDE_RAIL_WIDTH = 'w-10'

/**
 * Shared shell for docked right chat panels (width applied via inline style).
 * No `pr-10`: the floating side rail is hidden while the dock is open.
 * `min-w-0` lets the flex child shrink instead of overflowing the chat row.
 */
export const CHAT_RIGHT_PANEL =
  'flex h-full min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-l border-border/50 bg-bg'

/** Minimum chat column width reserved when clamping the side dock. */
export const CHAT_COLUMN_MIN_USABLE_PX = 280

/** Absolute ceiling on simultaneously visible chat panes, even on ultrawide viewports. */
export const MAX_CHAT_PANES_HARD_CAP = 6

/** Default / clamp bounds for the right dock (px). */
/** 400 leaves a usable chat column beside the default sidebar (~220). */
export const DOCK_WIDTH_DEFAULT_PX = 400
export const DOCK_WIDTH_MIN_PX = 280
export const DOCK_WIDTH_MAX_PX = 960

/**
 * localStorage key for immersive dock mode (unified Agent + panel tabs).
 * Legacy values meant “wide side dock”; readers treat `'1'` as immersive.
 */
export const DOCK_EXPANDED_KEY = 'vyotiq.dockExpanded'

/** localStorage key for which immersive tab is focused (`agent` or a panel id). */
export const IMMERSIVE_TAB_KEY = 'vyotiq.immersiveTab'

/** localStorage key for right-dock width in px. */
export const DOCK_WIDTH_KEY = 'vyotiq.dockWidth'

/** Shared max width for chat column content (messages + composer). */
export const CHAT_COLUMN_MAX = 'max-w-[840px]'

/** Centered chat column — transcript and composer share this wrapper. */
export const CHAT_COLUMN = `mx-auto w-full ${CHAT_COLUMN_MAX}`

/**
 * Floating edge-to-edge composer dock — overlays the chat stage bottom with a
 * small gap so the shell's rounded border never reads as clipped by the window
 * edge. Anchors to the nearest positioned ancestor (`[data-chat-stage]`); the
 * shell keeps `pointer-events-auto` so the wrapper never blocks the transcript.
 */
export const COMPOSER_FLOAT_DOCK = 'pointer-events-none absolute inset-x-0 bottom-2 z-20'

/** Gap between the floating composer shell and the pane bottom (`bottom-2`). */
export const COMPOSER_FLOAT_BOTTOM_INSET_PX = 8

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
 * row can scroll fully clear of the bar.
 */
export const COMPOSER_DOCK_RESERVE_VAR = '--vy-composer-dock-height'

/**
 * Extra clearance so the last transcript row sits fully above the reserved
 * dock when scrolled to the bottom (not just flush with its edge).
 */
export const COMPOSER_DOCK_CLEARANCE_PX = 12

/**
 * Extra bottom reserve while a run is live so streaming rows stay clear of a
 * reserved dock; idle chats keep only {@link COMPOSER_DOCK_CLEARANCE_PX}.
 */
export const COMPOSER_DOCK_LIVE_CLEARANCE_PX = 16

/** Fallback dock reserve when measured height is not yet available (`8rem`). */
export const COMPOSER_DOCK_FALLBACK_PX = 128

/** Composer textarea auto-grow cap — keep in sync with `COMPOSER_TEXTAREA_MAX_CLASS`. */
export const COMPOSER_TEXTAREA_MAX_PX = 280

/** Tailwind max-height matching `COMPOSER_TEXTAREA_MAX_PX`. */
export const COMPOSER_TEXTAREA_MAX_CLASS = 'max-h-[280px]'

/** Settings sidebar width (sm+). */
export const SETTINGS_NAV_WIDTH = 'sm:w-[220px]'

/** Shared max width for settings content column. */
export const SETTINGS_COLUMN_MAX = 'max-w-[680px]'

/** Settings content column — left-aligned beside the section nav. */
export const SETTINGS_COLUMN = `w-full ${SETTINGS_COLUMN_MAX}`

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
 * Compact vertical rhythm of the pinned turn-prompt stack (prompt + tasks band).
 * The page-colored cover prevents transcript rows from bleeding into the stack
 * without a gradient or shadow-like edge.
 */
export const TURN_PROMPT_STACK = 'py-2.5'

/**
 * Pinned state of {@link TURN_PROMPT_STACK}: flush with the scrollport's top
 * edge (see {@link CHAT_STAGE_TOP_SPACER}) over an opaque page-colored cover,
 * so transcript rows cannot bleed into the pinned content. No gradient or
 * shadow is applied.
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
export const QUESTION_GATE_SURFACE =
  'overflow-hidden rounded-md border-l-2 border-l-accent/60 bg-surface/60'
export const QUESTION_GATE_HEADER = 'flex items-center gap-2 px-3 pt-2.5 pb-1 text-xs text-fg'
export const QUESTION_GATE_BODY = 'px-3 py-2'
export const QUESTION_GATE_FOOTER = 'flex items-center gap-2 px-3 pb-2.5 pt-1'

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

/** App chrome dimensions — sidebar header row aligns with title bar height. */
export const SIDEBAR_WIDTH_PX = 248
export const SIDEBAR_WIDTH_MIN_PX = 180
export const SIDEBAR_WIDTH_MAX_PX = 420
export const SIDEBAR_COLLAPSED_WIDTH_PX = 44
/** Wider collapsed rail on macOS so the toggle clears traffic lights. */
export const SIDEBAR_COLLAPSED_WIDTH_DARWIN_PX = 72
export const TITLE_BAR_HEIGHT = 'h-9'
export const TITLE_BAR_HEIGHT_PX = 36

/**
 * Bottom status bar — the Agent V working indicator and the run it belongs to.
 * Deliberately shorter than {@link TITLE_BAR_HEIGHT}: it is a reading surface,
 * not a hit target, and the chat stage is already tight for vertical room.
 */
export const STATUS_BAR_HEIGHT = 'h-6'
export const STATUS_BAR_HEIGHT_PX = 24

/**
 * Windows/Linux caption-button strip width (3 × `sm:w-11` = 132px).
 * Side-dock titlebar tabs shrink by this so their left edge lines up with the
 * dock column while controls stay a TitleBar sibling (no absolute overlay).
 */
export const WINDOW_CONTROLS_WIDTH_PX = 132

/** Right padding for titlebar-embedded dock actions (Add panel / expand). */
export const TITLEBAR_ACTIONS_PAD = 'pr-2'

/** True when the shell draws custom min/max/close (Win/Linux; also jsdom fallback). */
export function showsWindowControls(
  platform: string | undefined = typeof window !== 'undefined'
    ? window.vyotiq?.platform
    : undefined
): boolean {
  return platform === 'win32' || platform === 'linux' || !platform
}

/**
 * Pixels a surface pinned to the top of the main column must hold open on its
 * right edge so its own controls never end up underneath the caption buttons.
 *
 * Zero on macOS: the traffic lights sit on the left and the shell insets them
 * out of the content's way already ({@link MACOS_TITLEBAR_INSET_PX}).
 */
export function windowControlsReservePx(
  platform: string | undefined = typeof window !== 'undefined'
    ? window.vyotiq?.platform
    : undefined
): number {
  return showsWindowControls(platform) ? WINDOW_CONTROLS_WIDTH_PX : 0
}

/**
 * Width class names must be complete static strings so Tailwind can emit them.
 * Template-interpolated `w-[${n}px]` is invisible to the scanner and never ships.
 * Expanded desktop width is applied via inline style so it can be drag-resized.
 */
export const SIDEBAR_WIDTH = 'w-[min(248px,92vw)]'
export const SIDEBAR_WIDTH_COLLAPSED = 'w-[44px]'
export const SIDEBAR_WIDTH_COLLAPSED_DARWIN = 'w-[72px]'

/** Named container — children use `@sidebar/…` for width-aware density. */
export const SIDEBAR_CONTAINER = '@container/sidebar'

/** Transcript scrollport — floating tasks use `@transcript/…` to sit beside the Plan rail. */
export const TRANSCRIPT_CONTAINER = '@container/transcript'

/** Sidebar shell — same surface as main column, no elevated chrome. */
export const SIDEBAR_SURFACE = 'bg-transparent'

/** Quiet micro copy — dense panels, git chrome, dock toolbars. */
export const MICRO_LABEL =
  'text-caption font-medium tracking-[var(--vy-tracking-tight)] text-muted'

/** Uppercase section labels in composer dropdowns and tool bodies. */
export const MICRO_LABEL_CAPS =
  'text-2xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-secondary'

/** Sidebar section label — quiet category headers. */
export const SIDEBAR_SECTION_LABEL = `m-0 px-1 ${MICRO_LABEL}`

/** Horizontal padding for sidebar list body. */
export const SIDEBAR_PAD_X = 'px-2'

/**
 * Sidebar toolbar row — collapse + new chat; same {@link TITLE_BAR_HEIGHT} as main title bar.
 */
export const SIDEBAR_TOOLBAR_ROW = `app-region-drag flex items-center gap-0.5 px-2 ${TITLE_BAR_HEIGHT}`

/** Search field row below the sidebar toolbar. */
export const SIDEBAR_SEARCH_ROW = 'app-region-no-drag min-w-0 px-2 pb-2'

/** Workspace group inside the chat list — flat, no nested card chrome. */
export const SIDEBAR_WORKSPACE_GROUP = 'flex flex-col gap-0.5'

/** Indent for chat rows nested under a workspace header. */
export const SIDEBAR_INDENT = 'pl-1'

/**
 * Active-state rules (pick one per surface; do not mix within a list):
 * - {@link SIDEBAR_ROW_ACTIVE} — scrollable lists (chat rows): left accent bar, no fill.
 * - {@link SIDEBAR_NAV_ACTIVE} — sparse footer/toolbar nav: filled surface + inset ring.
 * - {@link SIDEBAR_WORKSPACE_ROW_ACTIVE} — group headers: text emphasis only.
 */

/** Filled ring active state — sidebar footer nav, dock tabs, marketplace tabs. */
export const SIDEBAR_NAV_ACTIVE =
  'bg-surface text-fg-strong ring-1 ring-inset ring-border/50'

/** Shared row chrome for chat rows — left accent on active. */
export const SIDEBAR_ROW =
  'rounded-lg px-2 py-1.5 text-sm leading-normal border-l-2 border-l-transparent'

/** Workspace header row inside a card — no left accent bar. */
export const SIDEBAR_WORKSPACE_ROW = 'rounded-lg px-1.5 py-1.5 text-sm leading-normal'

/** Active workspace header row — text emphasis only, no fill chrome. */
export const SIDEBAR_WORKSPACE_ROW_ACTIVE = 'text-fg-strong font-medium'

/** Active sidebar row — left accent bar, no fill chrome. */
export const SIDEBAR_ROW_ACTIVE = 'border-l-fg-strong text-fg-strong font-medium'

/**
 * Session open in a pane but not focused — accent + light fill so multi-open
 * is glanceable beside the focused row.
 */
export const SIDEBAR_ROW_OPEN =
  'border-l-fg/55 text-fg bg-surface/20 font-medium'

/** Session in the focused pane — stronger fill + accent. */
export const SIDEBAR_ROW_FOCUSED =
  'border-l-fg-strong text-fg-strong bg-surface/45 font-semibold'

/**
 * Right-hand clearance a sidebar row must hold open while its hover actions are
 * showing, so the truncated label ends *before* the icon strip instead of being
 * painted over by it.
 *
 * Sized against the widest cluster any row shows: the delete confirm's two
 * `size-7` buttons plus their `gap-0.5` (58px). The steady-state strips are
 * narrower (two `size-6` buttons + `gap-px` = 49px), so 64px leaves a visible
 * gutter between the ellipsis and the first icon in both states.
 *
 * Applied only while the strip is visible — at rest the row keeps its own
 * padding so the label (and the cost badge that shares that edge) get the full
 * width. `vy-transition` does not animate padding, so the reserve snaps in as
 * the icons fade and the two never overlap mid-transition.
 */
export const SIDEBAR_ROW_ACTIONS_RESERVE =
  'group-hover:pr-16 group-focus-within:pr-16 [@media(hover:none)]:pr-16'

/**
 * Same idea as {@link SIDEBAR_ROW_ACTIONS_RESERVE} for a workspace header.
 * Its strip is two `size-6` buttons with `gap-1` (52px), so 56px keeps a
 * gutter after the truncated folder name.
 */
export const SIDEBAR_WORKSPACE_ROW_ACTIONS_RESERVE =
  'group-hover:pr-14 group-focus-within:pr-14 [@media(hover:none)]:pr-14'

/** Hover surface for sidebar rows. */
export const SIDEBAR_ROW_HOVER = 'hover:bg-surface/30 hover:text-fg'

/** Hover surface for workspace headers. */
export const SIDEBAR_WORKSPACE_ROW_HOVER = 'hover:bg-surface/25 hover:text-fg'

export { RUN_LIST_CAP } from '@shared/domain/runs'

/** localStorage key for desktop sidebar collapse preference. */
export const SIDEBAR_COLLAPSED_KEY = 'vyotiq.sidebarCollapsed'

/** localStorage key for desktop sidebar width in px. */
export const SIDEBAR_WIDTH_KEY = 'vyotiq.sidebarWidth'

/** localStorage key for chat agent-browser panel open preference. */
export const BROWSER_PANEL_OPEN_KEY = 'vyotiq.browserPanelOpen'

/** localStorage key for which chat right panel is open. */
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

/** Immersive unified-tab id for the Agent (timeline + composer) view. */
export type DockImmersiveTabId = 'agent' | ChatRightPanelId

/** Shared content shell inside the right dock (parent owns CHAT_RIGHT_PANEL + tab bar). */
export const CHAT_RIGHT_PANEL_BODY =
  'flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden'

/** Read live sidebar width for pane-capacity math (localStorage-backed). */
export function readSidebarWidthPxForCapacity(): number {
  if (typeof window === 'undefined') return SIDEBAR_WIDTH_MIN_PX
  try {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true') {
      return SIDEBAR_COLLAPSED_WIDTH_PX
    }
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
  // Side rail overlays the pane edge only while the dock is closed.
  const rail = dockOpen ? 0 : CHAT_SIDE_RAIL_WIDTH_PX
  return sidebar + rail + dock
}

/**
 * Clamp dock width so usable chat column(s) remain beside the sidebar.
 * With multiple panes, reserves {@link CHAT_COLUMN_MIN_USABLE_PX} per pane plus side rail.
 */
export function clampDockWidthPx(
  width: number,
  viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280,
  options?: { paneCount?: number; sidebarWidthPx?: number; dockOpen?: boolean }
): number {
  const paneCount = Math.max(1, options?.paneCount ?? 1)
  const sidebar = options?.sidebarWidthPx ?? readSidebarWidthPxForCapacity()
  const dockOpen = options?.dockOpen ?? true
  const rail = dockOpen ? 0 : CHAT_SIDE_RAIL_WIDTH_PX
  const reservedChrome = paneCount * CHAT_COLUMN_MIN_USABLE_PX + sidebar + rail
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
