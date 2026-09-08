import type { RefObject } from 'react'
import { IconButton, cn } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import {
  SIDEBAR_SEARCH_ROW,
  SIDEBAR_TOOLBAR_ROW,
  TITLE_BAR_HEIGHT
} from '@renderer/lib/utils/layout'
import { MACOS_TITLEBAR_INSET_PX, MACOS_TRAFFIC_LIGHT_Y } from '@shared/windowChrome'
import { SidebarBrandToggle } from './SidebarBrandToggle'
import { SidebarSearchChrome } from './SidebarSearchChrome'

export function SidebarTopBar({
  isDrawer,
  isDarwin,
  workspaceReady,
  searchRef,
  sessionQuery,
  onToggleSidebar,
  onSessionQuery,
  onOpenHome
}: {
  isDrawer: boolean
  isDarwin: boolean
  workspaceReady: boolean
  searchRef: RefObject<HTMLInputElement | null>
  sessionQuery: string
  onToggleSidebar: () => void
  onSessionQuery: (q: string) => void
  onOpenHome: () => void
}) {
  const headerStyle = isDarwin ? { paddingLeft: MACOS_TITLEBAR_INSET_PX } : undefined
  const alignWithTitleBar = !isDrawer

  return (
    <header
      className="app-region-drag shrink-0 flex flex-col"
      style={headerStyle}
    >
      <div
        className={cn(
          alignWithTitleBar ? SIDEBAR_TOOLBAR_ROW : 'flex items-center gap-0.5 px-2 py-1.5'
        )}
      >
        <div className="app-region-no-drag shrink-0">
          <SidebarBrandToggle isDrawer={isDrawer} onToggleSidebar={onToggleSidebar} />
        </div>

        <div className="app-region-no-drag shrink-0">
          <IconButton
            icon="home"
            label="Home"
            size="sm"
            variant="bare"
            title={`Home (${shortcutLabel('goHome')})`}
            onClick={onOpenHome}
          />
        </div>
      </div>

      <div className={SIDEBAR_SEARCH_ROW}>
        <SidebarSearchChrome
          searchRef={searchRef}
          sessionQuery={sessionQuery}
          workspaceReady={workspaceReady}
          onSessionQuery={onSessionQuery}
        />
      </div>
    </header>
  )
}

export function SidebarCollapsedHeader({
  isDrawer,
  isCollapsed,
  isDarwin,
  onToggleSidebar,
  onOpenHome,
  onAddWorkspace
}: {
  isDrawer: boolean
  isCollapsed: boolean
  isDarwin: boolean
  onToggleSidebar: () => void
  onOpenHome: () => void
  onAddWorkspace?: () => void
}) {
  const headerStyle = isDarwin
    ? isCollapsed
      ? { paddingTop: MACOS_TRAFFIC_LIGHT_Y + 10 }
      : { paddingLeft: MACOS_TITLEBAR_INSET_PX }
    : undefined

  return (
    <header
      className="app-region-drag flex shrink-0 flex-col items-center px-2 pb-1"
      style={headerStyle}
    >
      <div
        className={cn(
          'flex w-full items-center justify-start',
          isCollapsed && isDarwin ? 'min-h-9' : TITLE_BAR_HEIGHT
        )}
      >
        <div className="app-region-no-drag">
          <SidebarBrandToggle
            isDrawer={isDrawer}
            isCollapsed={isCollapsed}
            onToggleSidebar={onToggleSidebar}
            size="md"
          />
        </div>
      </div>
        <div className="app-region-no-drag">
          <IconButton
            icon="home"
            label="Home"
            size="sm"
            variant="bare"
            title={`Home (${shortcutLabel('goHome')})`}
            onClick={onOpenHome}
          />
        </div>
        {onAddWorkspace ? (
          <div className="app-region-no-drag">
            <IconButton
              icon="folderPlus"
              label="Add workspace"
              size="sm"
              variant="bare"
              title="Add workspace"
              onClick={onAddWorkspace}
            />
          </div>
        ) : null}
    </header>
  )
}
