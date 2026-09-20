import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { NavItem, cn } from '@renderer/lib/ui'
import { UpdatePanel } from '@renderer/features/updates/UpdatePanel'
import { markAnnounced, useUpdateAnnouncement } from '@renderer/features/updates/updaterStore'

function statusLabel(status: string, version: string): string {
  switch (status) {
    case 'downloading':
      return `Downloading version ${version}`
    case 'downloaded':
      return `Version ${version} ready to install`
    default:
      return `Version ${version} is available`
  }
}

/**
 * Sidebar rail entry for an available update — the app's one automatic update
 * surface. It appears on its own the moment main reports a new version, opens
 * its panel once per version so the update is never missed, and then stays as
 * a quiet rail item beside Notifications. There is no dismissal: it is out of
 * the way by construction, and hiding it is what used to leave users stranded
 * on an old build.
 *
 * Renders nothing when the install is current, so the rail is unchanged in the
 * common case.
 */
export function UpdateNavItem({ collapsed }: { collapsed: boolean }): ReactNode {
  const { info, status, progress, autoOpen } = useUpdateAnnouncement()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const { position, close } = useDropdownMenu({
    open,
    onOpenChange: setOpen,
    triggerRef,
    panelRef,
    placement: 'up',
    align: 'start',
    trapFocus: true,
    autoFocusFirst: true
  })

  const version = info?.version ?? ''

  // Announce once per version: the panel opens itself the first time a version
  // shows up, and closing it leaves the rail entry behind.
  useEffect(() => {
    if (!autoOpen || !version) return
    setOpen(true)
    markAnnounced(version)
  }, [autoOpen, version])

  // A version that arrives while the panel is open (download finished, say)
  // keeps it open; an update that disappears must not leave it orphaned.
  useEffect(() => {
    if (info == null && open) close(false)
  }, [info, open, close])

  if (info == null) return null

  const label = statusLabel(status, version)

  const panel =
    open && position ? (
      <div
        ref={panelRef}
        id={menuId}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        className="app-region-no-drag fixed z-dropdown flex max-h-[min(30rem,72vh)] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-y-auto rounded-md border border-border bg-card shadow-menu animate-menu-in origin-bottom"
        style={{
          top: position.placement === 'up' ? undefined : position.top,
          bottom: position.placement === 'up' ? window.innerHeight - position.top : undefined,
          left: position.left,
          minWidth: 240
        }}
      >
        <UpdatePanel info={info} status={status} progress={progress} />
      </div>
    ) : null

  return (
    <>
      <NavItem
        buttonRef={triggerRef}
        label="Update available"
        icon="download"
        variant={collapsed ? 'icon' : 'sidebar'}
        className={collapsed ? undefined : 'w-full'}
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? menuId : undefined}
        trailing={
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex size-1.5 rounded-full bg-accent',
              collapsed ? 'absolute right-1 top-1' : ''
            )}
          />
        }
        onClick={() => setOpen((prev) => !prev)}
      />
      {panel ? createPortal(panel, document.body) : null}
    </>
  )
}
