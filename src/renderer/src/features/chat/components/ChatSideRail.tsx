import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { IconButton, cn } from '@renderer/lib/ui'
import type { IconName } from '@renderer/lib/icons'
import { shortcutAriaKeys, shortcutLabel } from '@renderer/lib/shortcuts'
import { CHAT_SIDE_RAIL_TOP_INSET, CHAT_SIDE_RAIL_WIDTH, type ChatRightPanelId } from '@renderer/lib/utils/layout'
import { DOCK_PANELS, PANEL_SHORTCUT } from '@renderer/lib/utils/dockPanels'
import { useRunTodos } from '../hooks/useRunTodos'
import { TasksRailButton } from './TasksFloatingList'

const RAIL_ICON_ACTIVE =
  'bg-surface text-fg ring-1 ring-inset ring-border/50 rounded-lg'

/** Counts above this read as "a lot" — the badge has room for two glyphs. */
const RAIL_COUNT_MAX = 9

/** How long a {@link RailPanelState.detail} may be before the host truncates it. */
export const RAIL_DETAIL_MAX = 48

/**
 * Live state a rail button can carry, keyed by panel.
 *
 * Two markers, one meaning each: a pulse says the run is doing this *now*, a
 * count says something is waiting for the reader. A panel with neither shows
 * a plain icon — the rail never invents a signal it has no data for (the Pull
 * request panel has no state the app knows without a network round trip).
 */
export type RailPanelState = {
  /** The run is working in this panel right now. */
  active?: boolean
  /** Items waiting for the reader (pending changes). */
  count?: number
  /** Appended to the tooltip / accessible name, e.g. `Editing src/app.ts`. */
  detail?: string
}

/** Pulsing dot — same marker the browser rail has used for agent activity. */
function RailPulse(): ReactNode {
  return (
    <span className="pointer-events-none absolute right-0.5 top-0.5 z-10 flex size-2" aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:animate-none" />
      <span className="relative inline-flex size-2 rounded-full bg-accent" />
    </span>
  )
}

/** Corner count — same compact badge the collapsed sidebar nav uses. */
function RailCount({ count }: { count: number }): ReactNode {
  return (
    <span
      className="pointer-events-none absolute right-0.5 top-0.5 z-10 inline-flex min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-3xs font-medium leading-3 text-accent-fg"
      aria-hidden
      data-rail-count
    >
      {count > RAIL_COUNT_MAX ? `${RAIL_COUNT_MAX}+` : count}
    </span>
  )
}

/**
 * One rail slot: the toggle plus whichever marker its state earns.
 * `active` wins over `count` — what is happening now matters more than what
 * is queued, and two markers on a 28px button is noise.
 */
function RailPanelButton({
  panel,
  icon,
  label,
  title,
  open,
  state,
  keys,
  tabIndex,
  onSelect
}: {
  panel: ChatRightPanelId
  icon: IconName
  label: string
  title: string
  open: boolean
  /** `aria-keyshortcuts` form of this panel's chord. */
  keys: string
  state: RailPanelState | undefined
  tabIndex: number
  onSelect: (panel: ChatRightPanelId) => void
}): ReactNode {
  const active = Boolean(state?.active)
  const count = state?.count ?? 0
  const marker = active ? <RailPulse /> : count > 0 ? <RailCount count={count} /> : null
  const suffix = state?.detail ? ` · ${state.detail}` : ''
  return (
    <div className="relative" data-rail-row={panel} data-rail-active={active ? '1' : undefined}>
      <IconButton
        icon={icon}
        label={`${label}${suffix}`}
        title={`${title}${suffix}`}
        variant="ghost"
        size="sm"
        tabIndex={tabIndex}
        aria-pressed={open}
        aria-keyshortcuts={keys}
        className={cn('text-muted hover:text-fg', open && RAIL_ICON_ACTIVE)}
        onClick={() => onSelect(panel)}
      />
      {marker}
    </div>
  )
}

/**
 * Plan rail slot: the standard doc-icon button until the run has tasks, then
 * the live tasks button itself (status icon + count + hover card) — never both.
 */
function PlanRailRow({
  open,
  baseLabel,
  title,
  docIcon,
  workspacePath,
  runId,
  running,
  keys,
  tabIndex,
  onSelectPanel
}: {
  open: boolean
  baseLabel: string
  title: string
  docIcon: IconName
  keys: string
  workspacePath: string | null
  runId: string | null
  running: boolean
  tabIndex: number
  onSelectPanel: (panel: ChatRightPanelId) => void
}) {
  const { data, loaded } = useRunTodos({
    workspacePath,
    runId,
    running,
    active: Boolean(workspacePath && runId),
    live: true
  })

  // The agent just created todos: empty -> non-empty across poll loads, with
  // the first completed load acting as the baseline. A rail that mounts onto
  // an existing run (app restart, lazy rail) loads todos with items on its
  // first observation — that is NOT a creation, so the card stays closed.
  const baselineRef = useRef<boolean | null>(null)
  const prevHadItemsRef = useRef(false)
  const [justCreated, setJustCreated] = useState(false)
  useEffect(() => {
    if (!loaded) return
    const has = (data?.items.length ?? 0) > 0
    if (baselineRef.current === null) {
      baselineRef.current = has
      prevHadItemsRef.current = has
      return
    }
    if (has && !prevHadItemsRef.current) setJustCreated(true)
    else if (!has && prevHadItemsRef.current) setJustCreated(false)
    prevHadItemsRef.current = has
  }, [data, loaded])

  if (!data || data.items.length === 0) {
    return (
      <IconButton
        icon={docIcon}
        label={baseLabel}
        title={title}
        variant="ghost"
        size="sm"
        tabIndex={tabIndex}
        aria-pressed={open}
        aria-keyshortcuts={keys}
        className={cn('text-muted hover:text-fg', open && RAIL_ICON_ACTIVE)}
        onClick={() => onSelectPanel('plan')}
      />
    )
  }

  return (
    <TasksRailButton
      data={data}
      running={running}
      autoOpen={justCreated}
      pressed={open}
      tabIndex={tabIndex}
      keyShortcuts={keys}
      onOpenPlan={() => onSelectPanel('plan')}
      labelSuffix={` · ${title}`}
    />
  )
}

/**
 * Floating right rail for toggling chat secondary panels.
 * Overlays the pane edge so the transcript can scroll edge-to-edge (scrollbar
 * sits under the rail rather than stopping short of it), starting below the
 * title bar so it never reaches into the window controls' column.
 *
 * The outer element is positioning and gradient only; the strip inside is the
 * toolbar, and it owns the accessible name so the rail is not announced twice.
 */
export function ChatSideRail({
  activePanel,
  onSelectPanel,
  onExpandPanels,
  workspacePath = null,
  runId = null,
  running = false,
  panelState,
  className
}: {
  activePanel: ChatRightPanelId | null
  onSelectPanel: (panel: ChatRightPanelId) => void
  /** Re-enter immersive when panels remain after collapsing from Agent. */
  onExpandPanels?: () => void
  workspacePath?: string | null
  runId?: string | null
  running?: boolean
  /** Live per-panel markers — see {@link RailPanelState}. */
  panelState?: Partial<Record<ChatRightPanelId, RailPanelState>>
  className?: string
}) {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const buttonCount = DOCK_PANELS.length + (onExpandPanels ? 1 : 0)
  /**
   * Roving tab stop. The rail is a toolbar, not seven independent controls:
   * one Tab reaches it and the arrows walk it, so a keyboard reader does not
   * pay six extra stops to get from the transcript to the composer.
   */
  const [focusIndex, setFocusIndex] = useState(0)
  // Losing the Expand button while it held the stop would leave the rail with
  // no tabbable control at all.
  const tabStop = Math.min(focusIndex, buttonCount - 1)

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const strip = stripRef.current
    if (!strip) return
    const buttons = Array.from(strip.querySelectorAll<HTMLButtonElement>('button'))
    if (buttons.length === 0) return
    const current = buttons.findIndex((el) => el === document.activeElement)
    let next = current
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      next = current === -1 ? 0 : (current + 1) % buttons.length
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      next = current === -1 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length
    } else if (event.key === 'Home') {
      next = 0
    } else if (event.key === 'End') {
      next = buttons.length - 1
    } else {
      return
    }
    event.preventDefault()
    setFocusIndex(next)
    buttons[next]?.focus()
  }, [])

  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-0 right-0 z-dropdown flex flex-col items-center justify-start overflow-visible bg-gradient-to-l from-bg via-bg/70 to-transparent',
        // Anchored below the title bar rather than padded from the stage top:
        // the rail shares its column with the caption buttons, and the gradient
        // must not paint across them either.
        CHAT_SIDE_RAIL_TOP_INSET,
        CHAT_SIDE_RAIL_WIDTH,
        className
      )}
      data-chat-side-rail
    >
      <div
        ref={stripRef}
        role="toolbar"
        aria-orientation="vertical"
        aria-label="Panels"
        className="pointer-events-auto flex w-full flex-col items-center gap-1 py-0.5"
        onKeyDown={onKeyDown}
      >
        {DOCK_PANELS.map((item, index) => {
          const open = activePanel === item.id
          const baseLabel = open ? item.hideLabel : item.showLabel
          const chord = PANEL_SHORTCUT[item.id]
          const title = `${baseLabel} (${shortcutLabel(chord)})`
          const keys = shortcutAriaKeys(chord)
          const tabIndex = index === tabStop ? 0 : -1
          if (item.id === 'plan') {
            return (
              <div key={item.id} data-plan-rail-row data-rail-row="plan">
                <PlanRailRow
                  open={open}
                  baseLabel={baseLabel}
                  title={title}
                  docIcon={item.icon}
                  workspacePath={workspacePath}
                  runId={runId}
                  running={running}
                  keys={keys}
                  tabIndex={tabIndex}
                  onSelectPanel={onSelectPanel}
                />
              </div>
            )
          }
          return (
            <RailPanelButton
              key={item.id}
              panel={item.id}
              icon={item.icon}
              label={baseLabel}
              title={title}
              open={open}
              // An open panel shows its own state; a marker on its toggle
              // would only repeat it.
              state={open ? undefined : panelState?.[item.id]}
              keys={keys}
              tabIndex={tabIndex}
              onSelect={onSelectPanel}
            />
          )
        })}
        {onExpandPanels ? (
          <IconButton
            icon="maximize"
            label="Expand panel"
            variant="ghost"
            size="sm"
            tabIndex={DOCK_PANELS.length === tabStop ? 0 : -1}
            className="mt-0.5 text-muted hover:text-fg"
            onClick={onExpandPanels}
          />
        ) : null}
      </div>
    </div>
  )
}
