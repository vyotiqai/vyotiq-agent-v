import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SlashCommandDescriptor, SlashMcpServer } from '@shared/ipc'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
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

const SLASH_MAX_PX = 420

const NO_SERVERS: readonly SlashMcpServer[] = []

/**
 * The `/` menu: skills, commands, rules and MCP tools, one line each, grouped
 * under quiet labels (MCP tools under their server's name). The footer says
 * what the row under the pointer or keyboard does and what accepting it does.
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

  const { left, width, maxHeight } = clampComposerDropdownPanel({
    position,
    maxWidthPx: SLASH_MAX_PX
  })

  const hovered = hoveredId ? commands.find((c) => c.id === hoveredId) : null
  const described = hovered ?? commands[activeIndex] ?? null
  const describedText = described ? slashFooterText(described) : ''
  const activeDescendant =
    activeIndex >= 0 && commands[activeIndex]
      ? `${listId}-opt-${commands[activeIndex]!.id}`
      : undefined

  return createPortal(
    <div
      ref={panelRef}
      className={cn(MENU_SURFACE, 'fixed flex origin-bottom flex-col text-sm')}
      style={{
        top: position.placement === 'up' ? undefined : position.top,
        bottom:
          position.placement === 'up' ? window.innerHeight - position.top : undefined,
        left,
        width,
        maxWidth: width,
        maxHeight
      }}
      role="listbox"
      id={listId}
      aria-label="Slash commands"
      aria-activedescendant={activeDescendant}
      tabIndex={0}
    >
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
        {loading && commands.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted">Loading commands…</div>
        ) : null}
        {listError && commands.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-danger" role="alert">
            {listError}
          </div>
        ) : null}
        {!loading && !listError && commands.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted">No matches</div>
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
                      detail={slashRowDetail(cmd, servers)}
                      hint={availabilityCtaLabel(cmd.availability) ?? undefined}
                    />
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      {described ? (
        <div className="shrink-0 border-t border-border p-1">
          <p className="m-0 px-2 py-1.5 text-xs text-muted" title={described.description}>
            <span className="font-medium text-fg">{slashRowLabel(described)}</span>
            {describedText ? ` — ${describedText}` : null}{' '}
            <span className="text-tertiary">{slashAcceptHint(described)}</span>
          </p>
        </div>
      ) : null}
    </div>,
    document.body
  )
}
