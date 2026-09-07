import { useLayoutEffect, useRef, useState } from 'react'
import { cn, Tooltip } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import type { PtySessionInfo } from '@shared/ipc'
import {
  DOCK_CHROME_ICON_HOVER,
  DOCK_QUICK_LAUNCH_BTN,
  dockPanelTabButtonClass,
  dockPanelTabCloseClass,
  dockPanelTabShellClass,
  tabMiddleClickHandlers
} from './PanelChrome'

/**
 * PTY session tabs (+ / split). Rendered in the dock tab bar when the terminal
 * panel is active so we do not stack a second tab row inside the panel body.
 */
export function TerminalSessionBar({
  sessions,
  activeId,
  splitId,
  onSelect,
  onKill,
  onCreate,
  onToggleSplit,
  className
}: {
  sessions: PtySessionInfo[]
  activeId: string | null
  splitId: string | null
  onSelect: (id: string) => void
  onKill: (id: string) => void
  onCreate: () => void
  onToggleSplit: () => void
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const activeSession = sessions.find((s) => s.id === activeId) ?? null

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return

    const measure = (): void => {
      // clientWidth 0 = not laid out yet (pre-paint / jsdom) — keep full chrome.
      setCompact(el.clientWidth > 0 && el.clientWidth < 168)
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={rootRef}
      className={cn('inline-flex h-7 w-full min-w-0 max-w-full items-center gap-0.5', className)}
      data-terminal-session-bar
      role="tablist"
      aria-label="Terminal sessions"
    >
      {sessions.length > 0 ? (
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0">
          {sessions.map((s) => {
            const selected = s.id === activeId
            const inSplit = Boolean(splitId && s.id === splitId)
            const label = s.running ? s.title : `${s.title} (exited)`
            const emphasized = selected || inSplit
            return (
              <div
                key={s.id}
                className={cn(
                  dockPanelTabShellClass(emphasized, true),
                  !selected && inSplit && 'bg-surface/55'
                )}
                {...tabMiddleClickHandlers(() => onKill(s.id))}
              >
                <Tooltip content={label}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={emphasized ? 0 : -1}
                    className={dockPanelTabButtonClass(emphasized)}
                    onKeyDown={(e) => {
                      if (e.key === 'Delete') {
                        e.preventDefault()
                        onKill(s.id)
                      }
                    }}
                    onClick={() => onSelect(s.id)}
                  >
                    <Icon
                      name="terminal"
                      size={14}
                      className={cn('shrink-0', emphasized ? 'text-fg' : 'text-secondary')}
                    />
                    <span className="min-w-0 truncate">{label}</span>
                  </button>
                </Tooltip>
                <Tooltip content={`Close ${s.title}`}>
                  <button
                    type="button"
                    className={dockPanelTabCloseClass(emphasized)}
                    aria-label={`Close ${s.title}`}
                    aria-keyshortcuts="Delete"
                    tabIndex={emphasized ? 0 : -1}
                    onClick={(e) => {
                      e.stopPropagation()
                      onKill(s.id)
                    }}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </Tooltip>
              </div>
            )
          })}
        </div>
      ) : null}
      <Tooltip content="New terminal">
        <button
          type="button"
          className={cn(DOCK_QUICK_LAUNCH_BTN, DOCK_CHROME_ICON_HOVER)}
          aria-label="New terminal"
          onClick={onCreate}
        >
          <Icon name="plus" size={14} className="shrink-0" />
        </button>
      </Tooltip>
      {activeSession && !compact ? (
        <Tooltip content={splitId ? 'Unsplit terminals' : 'Split terminal'}>
          <button
            type="button"
            className={cn(
              DOCK_QUICK_LAUNCH_BTN,
              DOCK_CHROME_ICON_HOVER,
              splitId && 'bg-surface text-fg shadow-sm'
            )}
            aria-label={splitId ? 'Unsplit terminals' : 'Split terminal'}
            aria-pressed={splitId != null}
            onClick={onToggleSplit}
          >
            <Icon name="columns" size={14} className="shrink-0" />
          </button>
        </Tooltip>
      ) : null}
    </div>
  )
}
