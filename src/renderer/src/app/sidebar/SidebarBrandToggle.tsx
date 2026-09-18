import { IconButton, cn } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'

export function SidebarBrandToggle({
  isDrawer,
  isCollapsed = false,
  onToggleSidebar,
  size = 'sm',
  className
}: {
  isDrawer: boolean
  isCollapsed?: boolean
  onToggleSidebar: () => void
  size?: 'sm' | 'md'
  className?: string
}) {
  const toggleLabel = isDrawer
    ? 'Close menu'
    : isCollapsed
      ? 'Expand sidebar'
      : 'Collapse sidebar'
  const toggleTitle = isDrawer
    ? toggleLabel
    : `${toggleLabel} (${shortcutLabel('sidebar')})`

  return (
    <div className={cn('flex size-7 shrink-0 items-center justify-center', className)} data-sidebar-brand-toggle="">
      <IconButton
        icon={isDrawer ? 'close' : 'sidebar'}
        label={toggleLabel}
        title={toggleTitle}
        size={size}
        variant="bare"
        className="app-region-no-drag"
        aria-expanded={isDrawer ? true : !isCollapsed}
        aria-controls={isDrawer ? 'app-nav-drawer' : undefined}
        onClick={onToggleSidebar}
      />
    </div>
  )
}
