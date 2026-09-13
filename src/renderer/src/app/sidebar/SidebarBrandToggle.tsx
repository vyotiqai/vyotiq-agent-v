import { VyotiqMark } from '@renderer/lib/brand'
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
    <div
      className={cn(
        'group relative flex size-7 shrink-0 items-center justify-center',
        className
      )}
      data-sidebar-brand-toggle=""
    >
      <VyotiqMark
        size={size === 'md' ? 20 : 18}
        decorative
        className={cn(
          'pointer-events-none absolute text-fg vy-transition',
          'opacity-100 [@media(hover:hover)]:group-hover:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-0',
          '[@media(hover:none)]:opacity-0'
        )}
      />
      <IconButton
        icon={isDrawer ? 'close' : 'sidebar'}
        label={toggleLabel}
        title={toggleTitle}
        size={size}
        variant="bare"
        className={cn(
          'app-region-no-drag absolute vy-transition',
          'opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100',
          '[@media(hover:none)]:opacity-100'
        )}
        aria-expanded={isDrawer ? true : !isCollapsed}
        aria-controls={isDrawer ? 'app-nav-drawer' : undefined}
        onClick={onToggleSidebar}
      />
    </div>
  )
}
