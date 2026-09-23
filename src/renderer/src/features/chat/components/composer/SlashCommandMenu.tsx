import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SlashCommandDescriptor } from '@shared/ipc'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { cn } from '@renderer/lib/ui/cn'
import {
  clampComposerDropdownPanel,
  composerDropdownRow,
  composerDropdownSectionHeader
} from './composerDropdownLayout'
import { availabilityCtaLabel } from './slashCommandExecute'
import {
  buildSlashMenuSections,
  slashCommandRowCopy,
  slashGroupDisplayName,
  truncateSlashDescription
} from './slashCommandPresentation'

const SLASH_MAX_PX = 380

const stickyCategoryHeader = cn(composerDropdownSectionHeader, 'sticky top-0 z-sticky bg-card')

const stickyServerHeader =
  'sticky top-6 z-sticky m-0 border-b border-border/60 bg-card px-2.5 py-1 text-caption font-medium text-secondary'

export function SlashCommandMenu({
  open,
  commands,
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

  const sections = useMemo(() => buildSlashMenuSections(commands), [commands])

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
  const active = commands[activeIndex] ?? null
  const tooltipCmd = hovered ?? active
  const footerDescription = tooltipCmd?.description
    ? truncateSlashDescription(tooltipCmd.description)
    : ''
  const activeDescendant =
    activeIndex >= 0 && commands[activeIndex]
      ? `${listId}-opt-${commands[activeIndex]!.id}`
      : undefined

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-dropdown flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-menu animate-menu-in origin-bottom"
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
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-1">
        {loading && commands.length === 0 ? (
          <div className="px-2.5 py-2 text-xs text-secondary">Loading commands…</div>
        ) : null}
        {listError && commands.length === 0 ? (
          <div className="px-2.5 py-2 text-xs text-danger" role="alert">
            {listError}
          </div>
        ) : null}
        {!loading && !listError && commands.length === 0 ? (
          <div className="px-2.5 py-2 text-xs text-secondary">No matches</div>
        ) : null}
        {loading && commands.length > 0 ? (
          <div className="px-2.5 py-1 text-2xs text-secondary">Refreshing…</div>
        ) : null}
        {sections.map(({ group, startIndex, blocks }, sectionIndex) => {
          const heading = slashGroupDisplayName(group)
          const showServerLabels = blocks.some((b) => b.serverLabel)
          return (
            <div
              key={`${group}:${startIndex}`}
              className={cn(sectionIndex > 0 && 'mt-0.5 border-t border-border pt-0.5')}
              role="group"
              aria-label={heading}
            >
              <div className={stickyCategoryHeader}>{heading}</div>
              {blocks.map((block) => (
                <div
                  key={`${block.startIndex}:${block.serverLabel ?? 'all'}`}
                  role={block.serverLabel ? 'group' : undefined}
                  aria-label={block.serverLabel ?? undefined}
                >
                  {showServerLabels && block.serverLabel ? (
                    <div className={stickyServerHeader}>{block.serverLabel}</div>
                  ) : null}
                  <ul className="m-0 list-none p-0">
                    {block.items.map((cmd, offset) => {
                      const index = block.startIndex + offset
                      const selected = index === activeIndex
                      const cta = availabilityCtaLabel(cmd.availability)
                      const optionId = `${listId}-opt-${cmd.id}`
                      const { primary, secondary, title } = slashCommandRowCopy(cmd)
                      return (
                        <li key={cmd.id} role="presentation">
                          <button
                            type="button"
                            id={optionId}
                            role="option"
                            aria-selected={selected}
                            aria-label={title}
                            ref={(el) => {
                              optionRefs.current[index] = el
                            }}
                            className={cn(
                              composerDropdownRow,
                              selected && 'bg-surface-2 text-fg'
                            )}
                            onMouseEnter={() => {
                              onActiveIndexChange(index)
                              setHoveredId(cmd.id)
                            }}
                            onMouseLeave={() => setHoveredId(null)}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => onPick(cmd)}
                          >
                            <span className="min-w-0 flex-1">
                              <span
                                className="block truncate font-medium leading-snug"
                                title={title}
                              >
                                {primary}
                              </span>
                              {secondary ? (
                                <span
                                  className="block truncate font-mono text-caption leading-snug text-secondary"
                                  title={secondary}
                                >
                                  {secondary}
                                </span>
                              ) : null}
                            </span>
                            {cta ? (
                              <span className="shrink-0 text-2xs font-medium uppercase tracking-wide text-secondary">
                                {cta}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )
        })}
      </div>
      {footerDescription ? (
        <div
          className="shrink-0 border-t border-border px-2.5 py-1.5 text-xs leading-snug text-secondary"
          title={tooltipCmd?.description}
        >
          {footerDescription}
        </div>
      ) : null}
    </div>,
    document.body
  )
}
