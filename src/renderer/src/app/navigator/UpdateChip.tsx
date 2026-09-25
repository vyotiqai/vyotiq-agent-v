import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { announceLive } from '@renderer/lib/a11y/useLiveAnnouncer'
import { Icon } from '@renderer/lib/icons'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { MENU_SURFACE, cn } from '@renderer/lib/ui'
import { UpdatePanel } from '@renderer/features/updates/UpdatePanel'
import { markAnnounced, useUpdateAnnouncement } from '@renderer/features/updates/updaterStore'

const openRequests = new Set<() => void>()

/**
 * Open the update panel as if its chip were clicked — the inbox's "is ready"
 * row lands here. Nothing happens while no update is known.
 */
export function requestUpdatePanel(): void {
  for (const open of openRequests) open()
}

/**
 * The app's one update surface (see updaterStore): a chip in the navigator's
 * footer that appears the moment main reports a newer version, opens its panel
 * once per version, and says exactly where the update is — available,
 * downloading, or downloaded and ready to install. Nothing downloads or
 * installs until you press the button in the panel.
 *
 * Renders nothing while the install is current.
 */
export function UpdateChip({ runningCount = 0 }: { runningCount?: number }): ReactNode {
  const { info, status, progress, autoOpen, error } = useUpdateAnnouncement()
  const [open, setOpen] = useState(false)
  // Opened by the announcement rather than a click: it shows itself but leaves
  // focus where you were typing, so a stray Enter cannot download or restart.
  const [selfOpened, setSelfOpened] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const { position, close } = useDropdownMenu({
    open,
    onOpenChange: setOpen,
    triggerRef,
    panelRef,
    placement: 'up',
    align: 'start',
    trapFocus: !selfOpened,
    autoFocusFirst: !selfOpened
  })
  const version = info?.version ?? ''

  useEffect(() => {
    if (!autoOpen || !version) return
    setSelfOpened(true)
    setOpen(true)
    markAnnounced(version)
    // Focus stays put, so say it: the chip's name is what a reader would hear.
    announceLive(`Agent V ${version} is available. The update is in the navigator.`)
  }, [autoOpen, version])

  useEffect(() => {
    if (info == null && open) close(false)
  }, [info, open, close])

  useEffect(() => {
    const openFromRequest = (): void => {
      setSelfOpened(false)
      setOpen(true)
    }
    openRequests.add(openFromRequest)
    return () => {
      openRequests.delete(openFromRequest)
    }
  }, [])

  if (info == null) return null

  const percent = progress ? Math.max(0, Math.min(100, Math.round(progress.percent))) : 0
  const text =
    status === 'error'
      ? `${version} failed`
      : status === 'downloaded'
        ? `${version} ready`
        : status === 'downloading'
          ? `${version} · ${percent}%`
          : `${version} available`
  const label =
    status === 'error'
      ? `Updating to version ${version} failed`
      : status === 'downloaded'
      ? `Version ${version} is ready to install`
      : status === 'downloading'
        ? `Downloading version ${version}, ${percent}%`
        : `Version ${version} is available`

  const panel =
    open && position ? (
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        className={cn(
          'app-region-no-drag fixed flex max-h-[min(30rem,72vh)] w-[min(21.25rem,calc(100vw-1.5rem))] flex-col overflow-y-auto origin-bottom',
          MENU_SURFACE
        )}
        style={{
          top: position.placement === 'up' ? undefined : position.top,
          bottom: position.placement === 'up' ? window.innerHeight - position.top : undefined,
          left: position.left
        }}
      >
        <UpdatePanel info={info} status={status} progress={progress} error={error} runningCount={runningCount} />
      </div>
    ) : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-update-chip
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-caption font-medium tnum vy-transition focus-visible:vy-focus-ring',
          status === 'error' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent hover:text-accent-hover'
        )}
        onClick={() => {
          setSelfOpened(false)
          setOpen((prev) => !prev)
        }}
      >
        <Icon name={status === 'error' ? 'warningCircle' : 'download'} size={12} weight="bold" />
        {text}
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </>
  )
}
