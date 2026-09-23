import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { copyText } from '@renderer/lib/markdown/copyText'
import { ActionMenu, Button, IconButton, MENU_LABEL, MENU_ROW, MENU_ROW_IDLE, MENU_ROW_TEXT, MENU_SURFACE, Segmented, type ActionMenuItem } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/ui/cn'
import { Icon } from '@renderer/lib/icons'
import { AgentVSpinner } from '@renderer/lib/brand/AgentVSpinner'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { EmptyPanel } from './PanelChrome'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { resolveAddressBarTarget } from '@shared/utils/searchEngine'
import { CHAT_RIGHT_PANEL_BODY } from '@renderer/lib/utils/layout'
import type { AgentBrowserState } from '@shared/ipc'
import {
  clearBrowserRecents,
  filterBrowserRecents,
  groupBrowserRecents,
  loadBrowserRecents,
  recordBrowserVisit,
  type BrowserRecent
} from './browserRecents'
import {
  BROWSER_VIEWPORT_KEY,
  BROWSER_VIEWPORT_PRESETS,
  browserViewportPreset,
  parseBrowserViewportPreset,
  type BrowserViewportPresetId
} from './browserViewport'

const EMPTY: AgentBrowserState = {
  open: false,
  url: '',
  title: '',
  navigating: false,
  agentBusy: false,
  userControl: false,
  tabs: [],
  canGoBack: false,
  canGoForward: false
}

const RECENTS_BAR_KEY = 'vyotiq.browserRecentsBar'

function reportBrowserIpc(
  res: { ok: true } | { ok: false; error: string } | undefined,
  fallback: string,
  setStatusMsg: (msg: string) => void
): void {
  if (!res) {
    setStatusMsg(fallback)
    return
  }
  if (!res.ok) setStatusMsg(res.error)
}

/**
 * The page's address as the toolbar shows it: the host quiet, the path —
 * the part that changes as you click around — in full.
 */
export function splitBrowserUrl(raw: string | undefined): { host: string; rest: string } | null {
  const url = raw?.trim() ?? ''
  if (!url || url === 'about:blank') return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { host: url, rest: '' }
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return { host: parsed.host, rest: `${path}${parsed.search}${parsed.hash}` }
  } catch {
    return { host: url, rest: '' }
  }
}

/**
 * The inspector's Browser tab, hosting the main-process `WebContentsView`.
 */
export const AgentBrowserPanel = memo(function AgentBrowserPanel({
  className,
  workspacePath,
  activeRunId,
  visible = true,
  agentAction = null,
  onClose,
  onPopOut
}: {
  className?: string
  workspacePath?: string | null
  activeRunId?: string | null
  /** What the run's browser call is doing right now ("Clicking “Sign in”"). */
  agentAction?: string | null
  /** When false (CSS-hidden dock tab), clear native WebContentsView bounds so the overlay does not paint over other panels. */
  visible?: boolean
  onClose?: () => void
  /** Hide the dock while keeping the browser alive (PiP pop-out) — unlike onClose, which closes the browser. */
  onPopOut?: () => void
}) {
  const [state, setState] = useState<AgentBrowserState>(EMPTY)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [urlFocused, setUrlFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [recents, setRecents] = useState<BrowserRecent[]>(() => loadBrowserRecents())
  const [recentsBar, setRecentsBar] = useState(() => {
    try {
      return localStorage.getItem(RECENTS_BAR_KEY) === '1'
    } catch {
      return false
    }
  })
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [viewportPreset, setViewportPreset] = useState<BrowserViewportPresetId>(() => {
    try {
      return parseBrowserViewportPreset(localStorage.getItem(BROWSER_VIEWPORT_KEY))
    } catch {
      return 'fit'
    }
  })
  const viewportRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const blurTimerRef = useRef<number | null>(null)
  const lastRecordedUrl = useRef('')
  const lastRecordedTitle = useRef('')

  useEffect(() => {
    let cancelled = false
    // Push events always win over a late browserGetState resolve.
    let pushSeq = 0
    let getStateSeq = 0
    void window.vyotiq.browserGetState?.().then((res) => {
      if (cancelled) return
      const seq = ++getStateSeq
      void Promise.resolve().then(() => {
        if (cancelled || seq !== getStateSeq || pushSeq > 0) return
        if (!res.ok) {
          setLoadError(res.error)
          return
        }
        setLoadError(null)
        setState(res.data)
      })
    })
    const unsub = window.vyotiq.onBrowserState?.((next) => {
      if (!cancelled) {
        pushSeq += 1
        getStateSeq += 1
        setState(next)
      }
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  useEffect(() => {
    return () => {
      if (blurTimerRef.current != null) clearTimeout(blurTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!urlFocused) setUrlInput(state.url?.trim() || '')
  }, [state.url, urlFocused])

  useEffect(() => {
    const url = state.url?.trim() || ''
    if (!url || url === 'about:blank') {
      lastRecordedUrl.current = ''
      lastRecordedTitle.current = ''
      return
    }
    const title = state.title ?? ''
    // Re-record when title arrives for the same URL (URL often precedes title).
    if (url === lastRecordedUrl.current && title === lastRecordedTitle.current) return
    lastRecordedUrl.current = url
    lastRecordedTitle.current = title
    setRecents(recordBrowserVisit(url, title))
  }, [state.url, state.title])

  useLayoutEffect(() => {
    if (!visible) {
      void window.vyotiq.browserSetBounds?.(null)
      return undefined
    }

    const el = viewportRef.current
    if (!el) return undefined

    let cancelled = false
    const report = (): void => {
      if (cancelled) return
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return
      // Dock is open ⇒ side rail is hidden; use the viewport box as-is.
      void window.vyotiq.browserSetBounds?.({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }

    report()
    const raf = requestAnimationFrame(report)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(report) : null
    ro?.observe(el)
    window.addEventListener('resize', report)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', report)
      void window.vyotiq.browserSetBounds?.(null)
    }
  }, [visible, viewportPreset])

  useEffect(() => {
    if (!historyOpen) return
    const handler = (e: MouseEvent): void => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [historyOpen])

  useEffect(() => {
    if (!statusMsg) return
    const t = window.setTimeout(() => setStatusMsg(null), 2500)
    return () => window.clearTimeout(t)
  }, [statusMsg])

  const tabs = state.tabs ?? []
  const hasPage = Boolean(state.open) && tabs.length > 0
  const isSecureUrl = /^https:\/\//i.test(state.url?.trim() ?? '')
  const showAgentBanner = Boolean(state.agentBusy || state.userControl)
  const filteredRecents = useMemo(
    () => filterBrowserRecents(recents, urlFocused ? urlInput : ''),
    [recents, urlFocused, urlInput]
  )
  const recentGroups = useMemo(() => groupBrowserRecents(filteredRecents), [filteredRecents])

  const navigateTo = useCallback((raw: string) => {
    const input = raw.trim()
    if (!input) return
    const go = (target: string): void => {
      void window.vyotiq.browserNavigate?.(target, workspacePath ?? undefined)?.then((res) => {
        reportBrowserIpc(res, 'Navigation failed', setStatusMsg)
      })
      setHistoryOpen(false)
      urlInputRef.current?.blur()
    }
    if (/^https?:\/\//i.test(input) || /^[a-z0-9-]+\.[a-z]{2,}/i.test(input)) {
      go(resolveAddressBarTarget(input, 'duckduckgo'))
      return
    }
    const settingsCall = window.vyotiq.getSettings?.()
    if (!settingsCall) {
      go(resolveAddressBarTarget(input, DEFAULT_SETTINGS.searchEngine))
      return
    }
    void settingsCall.then((res) => {
      const engine =
        res && res.ok ? res.data.searchEngine : DEFAULT_SETTINGS.searchEngine
      go(resolveAddressBarTarget(input, engine))
    })
  }, [workspacePath])

  const handleNavigate = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      navigateTo(urlInput)
    },
    [navigateTo, urlInput]
  )

  const handleMenuAction = useCallback(
    (action: string) => {
      setMenuOpen(false)
      switch (action) {
        case 'screenshot': {
          if (!workspacePath) {
            setStatusMsg('Open a workspace to save a screenshot')
            break
          }
          void window.vyotiq
            .browserTakeScreenshot?.({
              workspacePath,
              runId: activeRunId ?? undefined
            })
            .then((res) => {
              if (res?.ok) {
                setStatusMsg(
                  activeRunId ? 'Screenshot saved to run artifacts' : 'Screenshot saved'
                )
              } else setStatusMsg(res && !res.ok ? res.error : 'Screenshot failed')
            })
          break
        }
        case 'reload':
          void window.vyotiq.browserReload?.(workspacePath ?? undefined)?.then((res) => {
            reportBrowserIpc(res, 'Reload failed', setStatusMsg)
          })
          break
        case 'copy-url':
          if (state.url) {
            void copyText(state.url).then((ok) => {
              setStatusMsg(ok ? 'URL copied' : 'Copy failed')
            })
          }
          break
        case 'recents-bar': {
          setRecentsBar((prev) => {
            const next = !prev
            try {
              localStorage.setItem(RECENTS_BAR_KEY, next ? '1' : '0')
            } catch {
              /* ignore */
            }
            return next
          })
          break
        }
        case 'clear-history':
          void window.vyotiq.browserClearBrowsingData?.({ kind: 'history', workspacePath: workspacePath ?? undefined }).then((res) => {
            if (!res?.ok) {
              setStatusMsg(res && !res.ok ? res.error : 'Failed to clear history')
              return
            }
            clearBrowserRecents()
            lastRecordedUrl.current = ''
            lastRecordedTitle.current = ''
            setRecents([])
            setStatusMsg('Browsing history cleared')
          })
          break
        case 'clear-cookies':
          void window.vyotiq.browserClearBrowsingData?.({ kind: 'cookies', workspacePath: workspacePath ?? undefined }).then((res) => {
            if (!res?.ok) {
              setStatusMsg(res && !res.ok ? res.error : 'Failed to clear cookies')
              return
            }
            setStatusMsg('Cookies cleared')
          })
          break
        case 'clear-cache':
          void window.vyotiq.browserClearBrowsingData?.({ kind: 'cache' }).then((res) => {
            if (!res?.ok) {
              setStatusMsg(res && !res.ok ? res.error : 'Failed to clear cache')
              return
            }
            setStatusMsg('Cache cleared')
          })
          break
        case 'pip-toggle': {
          void window.vyotiq.browserPipToggle?.().then((res) => {
            if (res && !res.ok) {
              setStatusMsg(res.error)
              return
            }
            if (res?.ok && res.data.pip) onPopOut?.()
          })
          break
        }
        case 'close':
          // onClose → closeDockTab('browser') also calls browserClose; invoke here
          // so Close works even if onClose is omitted in tests.
          void window.vyotiq.browserClose?.()
          onClose?.()
          break
        default:
          break
      }
    },
    [activeRunId, onClose, onPopOut, state.url, workspacePath]
  )

  const viewportSpec = browserViewportPreset(viewportPreset)
  const viewportFitted = viewportSpec.id === 'fit'
  const setViewport = useCallback((next: BrowserViewportPresetId) => {
    setViewportPreset(next)
    try {
      localStorage.setItem(BROWSER_VIEWPORT_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])
  // Fit and one fixed width: the one in use, or a phone's.
  const fixedPreset = viewportFitted ? browserViewportPreset('iphone') : viewportSpec
  const address = splitBrowserUrl(state.url)
  const showAddress = !urlFocused && hasPage && address !== null
  const bannerDetail = agentAction?.trim() || state.title?.trim() || address?.host || ''

  const menuItems: ActionMenuItem[] = [
    {
      id: 'new-tab',
      label: 'New tab',
      icon: 'plus',
      onSelect: () => {
        void window.vyotiq.browserOpenTab?.({ workspacePath: workspacePath ?? undefined })
      }
    },
    ...(hasPage
      ? [
          { id: 'screenshot', label: 'Take screenshot', icon: 'image' as const, onSelect: () => handleMenuAction('screenshot') },
          { id: 'copy-url', label: 'Copy current URL', icon: 'copy' as const, onSelect: () => handleMenuAction('copy-url') },
          {
            id: 'pip',
            label: state.pip ? 'Return browser to panel' : 'Pop out to floating window',
            icon: 'external' as const,
            onSelect: () => handleMenuAction('pip-toggle')
          }
        ]
      : []),
    ...BROWSER_VIEWPORT_PRESETS.map((preset, index) => ({
      id: `viewport-${preset.id}`,
      label: preset.id === 'fit' ? 'Fit the panel' : preset.label,
      checked: viewportPreset === preset.id,
      separatorBefore: index === 0,
      onSelect: () => setViewport(preset.id)
    })),
    {
      id: 'recents-bar',
      label: 'Show recents bar',
      checked: recentsBar,
      separatorBefore: true,
      onSelect: () => handleMenuAction('recents-bar')
    },
    { id: 'clear-history', label: 'Clear browsing history', separatorBefore: true, onSelect: () => handleMenuAction('clear-history') },
    { id: 'clear-cookies', label: 'Clear cookies', onSelect: () => handleMenuAction('clear-cookies') },
    { id: 'clear-cache', label: 'Clear cache', onSelect: () => handleMenuAction('clear-cache') },
    { id: 'close', label: 'Close browser', icon: 'close', danger: true, separatorBefore: true, onSelect: () => handleMenuAction('close') }
  ]

  return (
    <div
      className={cn(CHAT_RIGHT_PANEL_BODY, className)}
      data-agent-browser-panel
      role="region"
      aria-label="Agent browser panel"
      aria-describedby="agent-browser-panel-desc"
    >
      <p id="agent-browser-panel-desc" className="sr-only">
        Embedded browser for agent web tasks. Page content is controlled by the agent; use the
        address bar and toolbar for manual navigation when user control is enabled.
      </p>
      {tabs.length > 1 ? (
        <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 [scrollbar-width:none]" data-browser-tabs>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                'group inline-flex h-6 max-w-[10rem] shrink-0 items-center rounded-md vy-transition',
                tab.active ? 'bg-surface-2 text-fg-strong' : 'text-muted hover:bg-surface hover:text-fg'
              )}
            >
              <button
                type="button"
                className="inline-flex h-full min-w-0 items-center gap-1.5 rounded-md px-2 text-xs focus-visible:vy-focus-ring"
                title={`${tab.title || tab.id}\n${tab.url}`}
                onClick={() => {
                  void window.vyotiq.browserSelectTab?.(tab.id, workspacePath ?? undefined)
                }}
              >
                <Icon name="globe" size={12} className="shrink-0" />
                <span className="truncate">{tab.title?.trim() || tab.id}</span>
              </button>
              <button
                type="button"
                className="-ml-1 mr-1 hidden size-4 shrink-0 place-items-center rounded-sm text-tertiary hover:bg-surface-2 hover:text-fg focus-visible:vy-focus-ring group-focus-within:inline-grid group-hover:inline-grid"
                aria-label={`Close tab ${tab.title || tab.id}`}
                onClick={() => {
                  void window.vyotiq.browserCloseTab?.(tab.id, workspacePath ?? undefined)
                }}
              >
                <Icon name="close" size={10} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <IconButton
          icon="arrowLeft"
          label="Back"
          size="sm"
          tone="muted"
          disabled={!state.canGoBack}
          onClick={() =>
            void window.vyotiq.browserBack?.(workspacePath ?? undefined)?.then((res) => {
              reportBrowserIpc(res, 'Back failed', setStatusMsg)
            })
          }
        />
        <IconButton
          icon="arrowRight"
          label="Forward"
          size="sm"
          tone="muted"
          disabled={!state.canGoForward}
          onClick={() =>
            void window.vyotiq.browserForward?.(workspacePath ?? undefined)?.then((res) => {
              reportBrowserIpc(res, 'Forward failed', setStatusMsg)
            })
          }
        />
        <IconButton
          icon="retry"
          label="Reload"
          size="sm"
          tone="muted"
          disabled={!hasPage || state.navigating}
          onClick={() =>
            void window.vyotiq.browserReload?.(workspacePath ?? undefined)?.then((res) => {
              reportBrowserIpc(res, 'Reload failed', setStatusMsg)
            })
          }
        />

        <div className="relative ml-1 min-w-0 flex-1" ref={historyRef}>
          <form onSubmit={handleNavigate}>
            <div className="relative flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-surface px-2 focus-within:vy-focus-ring">
              {state.navigating ? (
                <span className="inline-grid size-3 shrink-0 place-items-center text-tertiary">
                  <AgentVSpinner size={11} />
                </span>
              ) : (
                <Icon name={isSecureUrl ? 'lock' : 'globe'} size={12} className="shrink-0 text-tertiary" />
              )}
              <input
                ref={urlInputRef}
                type="text"
                data-browser-url
                className={cn(
                  'min-w-0 flex-1 bg-transparent font-mono text-caption outline-none placeholder:font-sans placeholder:text-xs placeholder:text-tertiary',
                  showAddress ? 'text-transparent caret-transparent' : 'text-fg'
                )}
                placeholder="Search or enter URL"
                aria-label="Search or enter URL"
                value={urlInput}
                onChange={(e) => {
                  setUrlInput(e.target.value)
                  setHistoryOpen(true)
                }}
                onFocus={() => {
                  setUrlFocused(true)
                  setHistoryOpen(true)
                  setTimeout(() => urlInputRef.current?.select(), 0)
                }}
                onBlur={() => {
                  if (blurTimerRef.current != null) clearTimeout(blurTimerRef.current)
                  blurTimerRef.current = window.setTimeout(() => {
                    blurTimerRef.current = null
                    setUrlFocused(false)
                    setHistoryOpen(false)
                    setUrlInput(state.url?.trim() || '')
                  }, 120)
                }}
                spellCheck={false}
              />
              {showAddress && address ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-[26px] right-2 flex items-center overflow-hidden whitespace-nowrap font-mono text-caption text-secondary"
                  data-browser-address
                >
                  <span className="truncate">
                    {address.host}
                    <span className="text-fg">{address.rest}</span>
                  </span>
                </span>
              ) : null}
            </div>
          </form>

          {historyOpen && recentGroups.length > 0 ? (
            <div
              className={cn(MENU_SURFACE, 'absolute left-0 right-0 top-full mt-1 max-h-[min(50vh,320px)] overflow-y-auto p-1')}
              data-browser-history-dropdown
            >
              {recentGroups.map((group) => (
                <div key={group.label}>
                  <div className={MENU_LABEL}>{group.label}</div>
                  {group.items.map((item) => (
                    <button
                      key={`${item.url}-${item.visitedAt}`}
                      type="button"
                      className={cn(MENU_ROW, MENU_ROW_IDLE, MENU_ROW_TEXT, 'text-xs')}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => navigateTo(item.url)}
                      title={item.url}
                    >
                      <Icon name="globe" size={12} className="shrink-0 text-tertiary" />
                      <span className="min-w-0 flex-1 truncate">{item.title?.trim() || item.url}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <Segmented
          label="Viewport size"
          value={viewportFitted ? 'fit' : fixedPreset.id}
          onChange={(id) => setViewport(id)}
          items={[
            { id: 'fit' as BrowserViewportPresetId, label: 'Fit', title: 'Fit the panel' },
            { id: fixedPreset.id, label: String(fixedPreset.width), title: fixedPreset.label }
          ]}
        />
        <ActionMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          placement="down"
          align="end"
          aria-label="Browser actions"
          items={menuItems}
          trigger={(t) => (
            <IconButton
              ref={t.ref}
              icon="more"
              label="More actions"
              size="sm"
              tone="muted"
              aria-expanded={t['aria-expanded']}
              aria-controls={t['aria-controls']}
              aria-haspopup={t['aria-haspopup']}
              onClick={t.onClick}
            />
          )}
        />
      </div>

      {showAgentBanner ? (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs" role="status" data-browser-agent-banner>
          {state.userControl ? (
            <>
              <Icon name="hand" size={12} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-fg">You have control of the browser</span>
              <Button size="xs" variant="ghost" onClick={() => void window.vyotiq.browserReleaseControl?.()}>
                Return to agent
              </Button>
            </>
          ) : (
            <>
              <span aria-hidden="true" className="size-1.5 shrink-0 animate-live rounded-full bg-accent" />
              <span className="min-w-0 flex-1 truncate text-muted">
                <span className="text-fg">Agent is browsing</span>
                {bannerDetail ? ` — ${bannerDetail}` : null}
              </span>
              <Button size="xs" variant="ghost" onClick={() => void window.vyotiq.browserTakeControl?.()}>
                Take control
              </Button>
            </>
          )}
        </div>
      ) : null}

      {recentsBar ? (
        <div className="flex h-8 shrink-0 items-center gap-1 overflow-hidden border-b border-border px-2 text-xs text-muted">
          <span className="shrink-0 px-1 text-tertiary">Recents</span>
          {recents.slice(0, 5).map((item) => (
            <button
              key={`${item.url}-${item.visitedAt}`}
              type="button"
              className="max-w-[7rem] truncate rounded-md px-1.5 py-0.5 text-secondary hover:bg-surface hover:text-fg focus-visible:vy-focus-ring"
              title={item.url}
              onClick={() => navigateTo(item.url)}
            >
              {item.title?.trim() || item.url}
            </button>
          ))}
        </div>
      ) : null}

      {loadError ? (
        <div className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-warning" role="alert">
          Browser state unavailable: {loadError}
        </div>
      ) : null}

      {statusMsg ? (
        <div className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted" role="status">
          {statusMsg}
        </div>
      ) : null}

      <div
        className={cn(
          'min-h-0 flex-1 bg-bg',
          viewportFitted ? 'relative' : 'flex items-center justify-center overflow-auto bg-sunken p-2'
        )}
      >
      <div
        ref={viewportRef}
        className={cn(
          'relative bg-bg',
          viewportFitted ? 'min-h-0 h-full' : 'shrink-0 overflow-hidden border border-border'
        )}
        style={
          viewportFitted
            ? undefined
            : {
                width: viewportSpec.width,
                height: viewportSpec.height,
                maxWidth: '100%',
                maxHeight: '100%'
              }
        }
        data-agent-browser-viewport
        data-browser-viewport={viewportSpec.id}
      >
        {!hasPage ? (
          <div className="absolute inset-0 flex flex-col overflow-auto px-5 py-4">
            {recents.length > 0 ? (
              <div>
                <p className={SECTION_LABEL}>Recents</p>
                <ul className="-mx-2 mt-2 list-none p-0">
                  {recents.slice(0, 12).map((item) => (
                    <li key={`${item.url}-${item.visitedAt}`}>
                      <button
                        type="button"
                        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-fg hover:bg-surface focus-visible:vy-focus-ring"
                        onClick={() => navigateTo(item.url)}
                        title={item.url}
                      >
                        <Icon name="globe" size={13} className="shrink-0 text-tertiary" />
                        <span className="min-w-0 truncate">{item.title?.trim() || item.url}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <EmptyPanel
                icon="globe"
                title="No page loaded"
                body="Enter a URL above, or ask the agent to open a page."
                centered
              />
            )}
          </div>
        ) : null}
      </div>
      </div>
    </div>
  )
})
