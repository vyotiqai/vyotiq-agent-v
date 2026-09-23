import { useEffect, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { VyotiqMark } from '@renderer/lib/brand/VyotiqMark'
import { IconButton, Keys, Tooltip, cn } from '@renderer/lib/ui'
import { TITLE_BAR_HEIGHT, showsWindowControls } from '@renderer/lib/utils/layout'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { MACOS_TITLEBAR_INSET_PX } from '@shared/windowChrome'

/** Width of the band's left block when the navigator is hidden. */
const COLLAPSED_LEFT_PX = 148
/** Windows caption strip: three 46px buttons. Nothing else may live there. */
export const CAPTION_BUTTON_PX = 46

function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    const api = window.vyotiq
    if (!api?.windowIsMaximized) return
    void api.windowIsMaximized().then((res) => {
      if (res.ok) setMaximized(res.data)
    })
    if (!api.onWindowMaximizedChanged) return
    return api.onWindowMaximizedChanged(setMaximized)
  }, [])
  return maximized
}

/**
 * The 36px band across the whole window. Three fixed things and nothing else:
 * the mark and the navigator toggle over the navigator column, the search
 * trigger centred on the window, and the caption buttons. Nothing portals in
 * here — panels keep their tabs in their own 40px row below the band, which is
 * what ended the three fights over this strip.
 *
 * The band is a window-drag region; every control in it opts out.
 */
export function TitleBar({
  navigatorOpen,
  navigatorWidthPx,
  onToggleNavigator,
  onOpenSearch,
  compact = false
}: {
  navigatorOpen: boolean
  navigatorWidthPx: number
  onToggleNavigator: () => void
  onOpenSearch: () => void
  /** Below the desktop breakpoint: the navigator is a drawer, the trigger shrinks. */
  compact?: boolean
}) {
  const showControls = showsWindowControls()
  const maximized = useMaximized()
  const isDarwin = window.vyotiq?.platform === 'darwin'
  const toggleLabel = `${navigatorOpen ? 'Hide' : 'Show'} navigator (${shortcutLabel('sidebar')})`

  return (
    <header
      className={cn('app-region-drag relative z-titlebar flex shrink-0 items-center bg-chrome', TITLE_BAR_HEIGHT)}
      data-titlebar
      aria-label="Window title bar"
    >
      <div
        className="flex h-full shrink-0 items-center gap-1 whitespace-nowrap pl-3"
        style={{
          width: compact ? undefined : navigatorOpen ? navigatorWidthPx : COLLAPSED_LEFT_PX,
          paddingLeft: isDarwin ? MACOS_TITLEBAR_INSET_PX : undefined
        }}
        data-titlebar-brand
      >
        <VyotiqMark size={15} className="text-fg-strong" decorative />
        <span className="ml-1.5 text-xs font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong">Agent V</span>
        <span className="flex-1" />
        <IconButton
          icon="sidebar"
          label={toggleLabel}
          size="sm"
          tone="muted"
          active={compact ? navigatorOpen : false}
          aria-expanded={navigatorOpen}
          aria-controls={compact ? 'app-nav-drawer' : undefined}
          className="app-region-no-drag mr-2"
          onClick={onToggleNavigator}
          data-navigator-toggle
        />
      </div>

      <button
        type="button"
        onClick={onOpenSearch}
        data-search-trigger
        aria-keyshortcuts="Control+K"
        className={cn(
          'app-region-no-drag absolute left-1/2 top-1/2 flex h-6 -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-md bg-surface px-2 text-xs text-tertiary vy-transition hover:bg-surface-2 hover:text-muted focus-visible:vy-focus-ring',
          compact ? 'w-[min(240px,40vw)]' : 'w-[min(380px,34vw)]'
        )}
      >
        <Icon name="search" size={14} />
        <span className="min-w-0 flex-1 truncate text-left">Search tasks, files and commands</span>
        <Keys keys={shortcutLabel('search').split('+')} />
      </button>

      {showControls ? (
        <div className="app-region-no-drag ml-auto flex h-full" data-titlebar-controls>
          <CaptionButton kind="min" label="Minimize" onClick={() => void window.vyotiq?.windowMinimize()} />
          <CaptionButton
            kind={maximized ? 'restore' : 'max'}
            label={maximized ? 'Restore' : 'Maximize'}
            onClick={() => void window.vyotiq?.windowMaximize()}
          />
          <CaptionButton kind="close" label="Close" onClick={() => void window.vyotiq?.windowClose()} />
        </div>
      ) : null}
    </header>
  )
}

function CaptionButton({
  kind,
  label,
  onClick
}: {
  kind: 'min' | 'max' | 'restore' | 'close'
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        style={{ width: CAPTION_BUTTON_PX }}
        className={cn(
          'grid h-full place-items-center text-secondary vy-transition focus-visible:vy-focus-ring',
          kind === 'close' ? 'hover:bg-window-close hover:text-window-close-fg' : 'hover:bg-surface hover:text-fg-strong'
        )}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          {kind === 'min' ? <path d="M0 5h10" stroke="currentColor" strokeWidth="1" /> : null}
          {kind === 'max' ? (
            <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" />
          ) : null}
          {kind === 'restore' ? (
            <>
              <rect x="0.5" y="2.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M2.5 2.5V1.8c0-.7.6-1.3 1.3-1.3h4.4c.7 0 1.3.6 1.3 1.3v4.4c0 .7-.6 1.3-1.3 1.3h-.7" fill="none" stroke="currentColor" strokeWidth="1" />
            </>
          ) : null}
          {kind === 'close' ? <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" /> : null}
        </svg>
      </button>
    </Tooltip>
  )
}
