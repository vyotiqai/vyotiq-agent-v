import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SlashCommandDescriptor, SlashMcpServer } from '@shared/ipc'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { Icon } from '@renderer/lib/icons'
import {
  cn,
  MENU_LABEL,
  MENU_ROW,
  MENU_ROW_ACTIVE,
  MENU_ROW_IDLE,
  MENU_ROW_TEXT,
  MENU_SURFACE,
  MenuItemBody
} from '@renderer/lib/ui'
import { BrandMark } from '@renderer/features/marketplace/BrandTile'
import { clampComposerDropdownPanel } from './composerDropdownLayout'
import { availabilityCtaLabel } from './slashCommandExecute'
import {
  buildSlashMenuBlocks,
  slashAcceptHint,
  slashFooterText,
  slashOptionName,
  slashRowDetail,
  slashRowIcon,
  slashRowLabel
} from './slashCommandPresentation'

/**
 * Width bounds. The panel grows with the composer's own input wrap so a wide
 * composer gets a wide menu, and stops here so a full-width pane does not
 * stretch the rows. Viewport clamping is the layout helper's job.
 */
const SLASH_PANEL_MIN_PX = 260
const SLASH_PANEL_MAX_PX = 420

const NO_SERVERS: readonly SlashMcpServer[] = []

/** One of the three non-list states the panel can be in. */
type SlashPanelState = 'results' | 'loading' | 'error' | 'empty'

/**
 * The `/` menu: skills, commands, rules and MCP tools under quiet group
 * labels (MCP tools under their server's name), a quiet header with the
 * result count, and a pinned footer that says what the row under the pointer
 * or keyboard does and what accepting it does. Loading, error and no-match
 * each get their own state, so they never read as an empty list.
 */
export function SlashCommandMenu({
  open,
  commands,
  mcpServers = NO_SERVERS,
  activeIndex,
  onActiveIndexChange,
  onPick,
  onDismiss,
  anchorRef,
  listId = 'slash-command-menu',
  loading,
  listError
}: {
  open: boolean
  commands: SlashCommandDescriptor[]
  /** Names and marks for the servers MCP tools belong to. */
  mcpServers?: readonly SlashMcpServer[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onPick: (command: SlashCommandDescriptor) => void
  onDismiss?: () => void
  anchorRef: RefObject<HTMLElement | null>
  listId?: string
  loading?: boolean
  listError?: string | null
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLElement | null>>([])
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const { position } = useDropdownMenu({
    open,
    onOpenChange: (next) => {
      if (!next) onDismiss?.()
    },
    triggerRef: anchorRef,
    panelRef,
    placement: 'up',
    align: 'start',
    disabled: !open,
    trapFocus: true
  })

  const servers = useMemo(() => new Map(mcpServers.map((s) => [s.id, s])), [mcpServers])
  const blocks = useMemo(() => buildSlashMenuBlocks(commands, servers), [commands, servers])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  if (!open || !position) return null

  // Responsive: the anchor is the composer's input wrap, so the menu tracks the
  // composer's own width between these bounds instead of one fixed size.
  // `position.minWidth` is the measured anchor width (floored), and it is
  // already re-measured on resize and scroll — no second layout read here.
  const { left, width, maxHeight } = clampComposerDropdownPanel({
    position,
    maxWidthPx: Math.min(
      SLASH_PANEL_MAX_PX,
      Math.max(SLASH_PANEL_MIN_PX, Math.round(position.minWidth))
    ),
    minHeightPx: 180
  })

  const state: SlashPanelState =
    commands.length > 0
      ? 'results'
      : listError
        ? 'error'
        : loading
          ? 'loading'
          : 'empty'

  const hovered = hoveredId ? commands.find((c) => c.id === hoveredId) : null
  const described = hovered ?? commands[activeIndex] ?? null
  const describedText = described ? slashFooterText(described) : null
  const activeDescendant =
    activeIndex >= 0 && commands[activeIndex]
      ? `${listId}-opt-${commands[activeIndex]!.id}`
      : undefined

  return createPortal(
    <div
      ref={panelRef}
      className={cn(
        MENU_SURFACE,
        '@container fixed flex origin-bottom flex-col text-sm'
      )}
      style={{
        top: position.placement === 'up' ? undefined : position.top,
        bottom:
          position.placement === 'up' ? window.innerHeight - position.top : undefined,
        left,
        width,
        maxWidth: width,
        maxHeight
      }}
      data-slash-panel
    >
      {/* Quiet header: what this list is, and how much of it there is. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
          Slash commands
        </span>
        {state === 'results' ? (
          <span className="shrink-0 text-caption text-tertiary tnum">
            {commands.length === 1 ? '1 command' : `${commands.length} commands`}
          </span>
        ) : null}
        {loading && commands.length > 0 ? (
          <Icon
            name="loader"
            size={13}
            className="shrink-0 motion-safe:animate-spin text-muted"
          />
        ) : null}
      </div>

      <div
        role="listbox"
        id={listId}
        aria-label="Slash commands"
        aria-activedescendant={activeDescendant}
        aria-busy={state === 'loading' ? true : undefined}
        tabIndex={0}
        data-slash-state={state}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1"
      >
        {state === 'loading' ? (
          <div
            className="flex items-center gap-2 px-2 py-2 text-xs text-muted"
            role="status"
          >
            <Icon name="loader" size={13} className="motion-safe:animate-spin" />
            <span>Loading commands…</span>
          </div>
        ) : null}

        {state === 'error' ? (
          <div
            className="flex items-start gap-2 px-2 py-2 text-xs text-danger"
            role="alert"
          >
            <Icon name="warningCircle" size={13} className="mt-px" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{listError}</span>
          </div>
        ) : null}

        {state === 'empty' ? (
          <div className="px-2 py-2">
            <p className="m-0 flex items-center gap-2 text-xs text-fg">
              <Icon name="search" size={13} className="text-muted" />
              <span>No matches</span>
            </p>
            <p className="m-0 pl-[21px] pt-1 text-caption text-tertiary">
              Keep typing to filter commands.
            </p>
          </div>
        ) : null}

        {blocks.map((block, blockIndex) => {
          const labelId = `${listId}-group-${blockIndex}`
          return (
            <div key={`${block.key}:${block.startIndex}`} role="group" aria-labelledby={labelId}>
              <div id={labelId} className={MENU_LABEL}>
                {block.label}
              </div>
              {block.items.map((cmd, offset) => {
                const index = block.startIndex + offset
                const selected = index === activeIndex
                const server = cmd.mcpServerId ? servers.get(cmd.mcpServerId) : undefined
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    id={`${listId}-opt-${cmd.id}`}
                    role="option"
                    aria-selected={selected}
                    aria-label={slashOptionName(cmd)}
                    ref={(el) => {
                      optionRefs.current[index] = el
                    }}
                    className={cn(MENU_ROW, selected ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}
                    onMouseEnter={() => {
                      onActiveIndexChange(index)
                      setHoveredId(cmd.id)
                    }}
                    onMouseLeave={() => setHoveredId(null)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(cmd)}
                  >
                    <MenuItemBody
                      lead={
                        <BrandMark
                          iconUrl={server?.iconUrl}
                          iconMono={server?.iconMono}
                          fallback={slashRowIcon(cmd)}
                          className="text-muted"
                        />
                      }
                      label={slashRowLabel(cmd)}
                      // Narrow panel: the label is the row's name, the description
                      // is the first thing to give way. Measured against the
                      // panel's own width, not the viewport's.
                      detail={
                        <span className="@max-[300px]:hidden">
                          {slashRowDetail(cmd, servers)}
                        </span>
                      }
                      hint={availabilityCtaLabel(cmd.availability) ?? undefined}
                    />
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* Pinned outside the scroll region: the footer never covers a row. */}
      <div className="shrink-0 border-t border-border p-1" data-slash-footer>
        {described ? (
          <p
            className="m-0 line-clamp-2 px-2 py-1.5 text-xs text-muted"
            title={described.description}
          >
            <span className="font-medium text-fg">{slashRowLabel(described)}</span>
            {describedText ? ` — ${describedText}` : null}{' '}
            <span className="text-tertiary">{slashAcceptHint(described)}</span>
          </p>
        ) : (
          <p className="m-0 px-2 py-1.5 text-xs text-tertiary">
            {state === 'empty' ? 'Nothing to select' : 'Nothing selected'}
          </p>
        )}
      </div>
    </div>,
    document.body
  )
}
