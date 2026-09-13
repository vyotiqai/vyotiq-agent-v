import { useMemo, useState } from 'react'
import { ActionMenu, Tooltip, cn } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import type { ChatRightPanelId } from '@renderer/lib/utils/layout'
import type { DockPanelDef } from '@renderer/lib/utils/dockPanels'
import { DOCK_CHROME_ICON_HOVER, DOCK_QUICK_LAUNCH_BTN } from './PanelChrome'
import { useToolbarIconOverflow } from './useToolbarIconOverflow'

export function DockQuickLaunch({
  panels,
  onOpenPanel,
  className
}: {
  panels: readonly DockPanelDef[]
  onOpenPanel: (id: ChatRightPanelId) => void
  className?: string
}) {
  const { ref, visibleCount } = useToolbarIconOverflow(panels.length)
  const [overflowOpen, setOverflowOpen] = useState(false)

  const visible = useMemo(() => panels.slice(0, visibleCount), [panels, visibleCount])
  const overflow = useMemo(() => panels.slice(visibleCount), [panels, visibleCount])

  if (panels.length === 0) return null

  return (
    <div
      ref={ref}
      className={cn('flex min-w-0 items-center justify-end gap-0.5 overflow-hidden', className)}
      data-dock-quick-launch
      role="group"
      aria-label="Open panel"
    >
      {visible.map((panel) => (
        <Tooltip key={panel.id} content={panel.showLabel}>
          <button
            type="button"
            className={cn(DOCK_QUICK_LAUNCH_BTN, 'shrink-0')}
            aria-label={panel.showLabel}
            onClick={() => onOpenPanel(panel.id)}
          >
            <Icon name={panel.icon} size={14} className="shrink-0" />
          </button>
        </Tooltip>
      ))}
      {overflow.length > 0 ? (
        <ActionMenu
          open={overflowOpen}
          onOpenChange={setOverflowOpen}
          placement="down"
          align="end"
          aria-label="More panels"
          items={overflow.map((panel) => ({
            id: panel.id,
            label: panel.label,
            icon: panel.icon,
            onSelect: () => {
              onOpenPanel(panel.id)
              setOverflowOpen(false)
            }
          }))}
          trigger={(props) => (
            <Tooltip content="More panels">
              <button
                ref={props.ref}
                type="button"
                className={cn(DOCK_QUICK_LAUNCH_BTN, DOCK_CHROME_ICON_HOVER, 'shrink-0')}
                aria-label="More panels"
                aria-expanded={props['aria-expanded']}
                aria-controls={props['aria-controls']}
                aria-haspopup={props['aria-haspopup']}
                onClick={props.onClick}
              >
                <Icon name="panels" size={14} className="shrink-0" />
              </button>
            </Tooltip>
          )}
        />
      ) : null}
    </div>
  )
}
