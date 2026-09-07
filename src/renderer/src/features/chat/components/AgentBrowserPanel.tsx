import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { copyText } from '@renderer/lib/markdown/copyText'
import { Tooltip } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/ui/cn'
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
 * Docked right-side panel hosting the main-process `WebContentsView`.
 * Styled to match Cursor's built-in browser chrome.
 */
export const AgentBrowserPanel = memo(function AgentBrowserPanel({
  className,
  workspacePath,
  activeRunId,
  visible = true,
  onClose
}: {
  className?: string
  workspacePath?: string | null
  activeRunId?: string | null
  /** When false (CSS-hidden dock tab), clear native WebContentsView bounds so the overlay does not paint over other panels. */
  visible?: boolean
  onClose?: () => void
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
  const menuRef = useRef<HTMLDivElement>(null)
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
    if (!menuOpen && !historyOpen) return
    const handler = (e: MouseEvent): void => {
      const target = e.target as Node
      if (menuOpen && menuRef.current && !menuRef.current.contains(target)) {
        setMenuOpen(false)
      }
      if (historyOpen && historyRef.current && !historyRef.current.contains(target)) {
        setHistoryOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen, historyOpen])

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
    [activeRunId, onClose, state.url, workspacePath]
  )

  const viewportSpec = browserViewportPreset(viewportPreset)
  const viewportFitted = viewportSpec.id === 'fit'

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
      {tabs.length > 0 ? (
        <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border/30 bg-bg px-1.5 pt-1.5">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                'group flex max-w-[10rem] shrink-0 items-center gap-0.5 rounded-t-md pr-0.5',
                tab.active ? 'bg-surface' : 'hover:bg-surface/60'
              )}
            >
              <button
                type="button"
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1 truncate px-2 py-1 text-caption',
                  tab.active ? 'font-medium text-fg' : 'text-muted hover:text-fg'
                )}
                title={`${tab.title || tab.id}\n${tab.url}`}
                onClick={() => {
                  void window.vyotiq.browserSelectTab?.(tab.id, workspacePath ?? undefined)
                }}
              >
                <GlobeGlyph className="shrink-0 opacity-60" size={12} />
                <span className="truncate">{tab.title?.trim() || tab.id}</span>
              </button>
              <button
                type="button"
                className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:bg-surface-2 hover:text-fg group-hover:opacity-100"
                title={tabs.length > 1 ? 'Close tab' : 'Close browser'}
                aria-label={
                  tabs.length > 1
                    ? `Close tab ${tab.title || tab.id}`
                    : 'Close browser'
                }
                onClick={() => {
                  if (tabs.length <= 1) {
                    handleMenuAction('close')
                    return
                  }
                  void window.vyotiq.browserCloseTab?.(tab.id, workspacePath ?? undefined)
                }}
              >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
            </div>
          ))}
          <button
            type="button"
            className="mb-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
            title="New tab"
            aria-label="New tab"
            onClick={() => {
              void window.vyotiq.browserOpenTab?.({ workspacePath: workspacePath ?? undefined })
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <NavIconButton
          label="Back"
          disabled={!state.canGoBack}
          onClick={() =>
            void window.vyotiq.browserBack?.(workspacePath ?? undefined)?.then((res) => {
              reportBrowserIpc(res, 'Back failed', setStatusMsg)
            })
          }
        >
          <polyline points="15 18 9 12 15 6" />
        </NavIconButton>
        <NavIconButton
          label="Forward"
          disabled={!state.canGoForward}
          onClick={() =>
            void window.vyotiq.browserForward?.(workspacePath ?? undefined)?.then((res) => {
              reportBrowserIpc(res, 'Forward failed', setStatusMsg)
            })
          }
        >
          <polyline points="9 18 15 12 9 6" />
        </NavIconButton>
        <NavIconButton
          label="Reload"
          disabled={!hasPage || state.navigating}
          onClick={() =>
            void window.vyotiq.browserReload?.(workspacePath ?? undefined)?.then((res) => {
              reportBrowserIpc(res, 'Reload failed', setStatusMsg)
            })
          }
        >
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </NavIconButton>

        <div className="relative min-w-0 flex-1" ref={historyRef}>
          <form onSubmit={handleNavigate}>
            <div
              className={cn(
                'flex items-center rounded-md border bg-surface px-2.5 py-1 text-xs transition-colors',
                urlFocused ? 'border-accent/60' : 'border-border/40'
              )}
            >
              {!urlFocused && hasPage && isSecureUrl ? (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="mr-1.5 shrink-0 text-muted"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              ) : null}
              {state.navigating ? (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="mr-1.5 shrink-0 animate-spin text-accent"
                  aria-hidden
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : null}
              <input
                ref={urlInputRef}
                type="text"
                data-browser-url
                className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted"
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
            </div>
          </form>

          {historyOpen && recentGroups.length > 0 ? (
            <div
              className="absolute left-0 right-0 top-full z-dropdown mt-1 max-h-[min(50vh,320px)] overflow-auto rounded-lg border border-border/60 bg-surface py-1 shadow-menu"
              data-browser-history-dropdown
            >
              {recentGroups.map((group) => (
                <div key={group.label}>
                  <div className="px-3 py-1 text-2xs font-medium uppercase tracking-wide text-muted">
                    {group.label}
                  </div>
                  {group.items.map((item) => (
                    <button
                      key={`${item.url}-${item.visitedAt}`}
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-surface-2"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => navigateTo(item.url)}
                      title={item.url}
                    >
                      <GlobeGlyph className="shrink-0 text-muted" size={12} />
                      <span className="min-w-0 flex-1 truncate">
                        {item.title?.trim() || item.url}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <label className="sr-only" htmlFor="agent-browser-viewport">
          Viewport size
        </label>
        <select
          id="agent-browser-viewport"
          className="h-7 max-w-[7.5rem] shrink-0 rounded-md border border-border/40 bg-surface px-1.5 text-xs text-fg"
          value={viewportPreset}
          aria-label="Viewport size"
          onChange={(event) => {
            const next = parseBrowserViewportPreset(event.target.value)
            setViewportPreset(next)
            try {
              localStorage.setItem(BROWSER_VIEWPORT_KEY, next)
            } catch {
              /* ignore */
            }
          }}
        >
          {BROWSER_VIEWPORT_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-fg/70 transition-colors hover:bg-surface-2"
            onClick={() => setMenuOpen((v) => !v)}
            title="More actions"
            aria-label="More actions"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-full z-dropdown mt-1 min-w-[13rem] rounded-lg border border-border/60 bg-surface py-1 shadow-menu">
              <MenuButton
                onClick={() => handleMenuAction('screenshot')}
                disabled={!hasPage}
              >
                Take Screenshot
              </MenuButton>
              <div className="my-1 border-t border-border/30" />
              <MenuButton onClick={() => handleMenuAction('reload')} disabled={!hasPage}>
                Reload
              </MenuButton>
              <MenuButton onClick={() => handleMenuAction('copy-url')} disabled={!state.url}>
                Copy Current URL
              </MenuButton>
              <div className="my-1 border-t border-border/30" />
              <MenuButton onClick={() => handleMenuAction('recents-bar')}>
                <span className="flex-1">Show Recents Bar</span>
                <span
                  className={cn(
                    'relative ml-2 inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
                    recentsBar ? 'bg-accent' : 'bg-surface-2'
                  )}
                  aria-hidden
                >
                  <span
                    className={cn(
                      'inline-block size-3 rounded-full bg-fg transition-transform',
                      recentsBar ? 'translate-x-3.5' : 'translate-x-0.5'
                    )}
                  />
                </span>
              </MenuButton>
              <div className="my-1 border-t border-border/30" />
              <MenuButton onClick={() => handleMenuAction('clear-history')}>
                Clear Browsing History
              </MenuButton>
              <MenuButton onClick={() => handleMenuAction('clear-cookies')}>
                Clear Cookies
              </MenuButton>
              <MenuButton onClick={() => handleMenuAction('clear-cache')}>Clear Cache</MenuButton>
              <div className="my-1 border-t border-border/30" />
              <MenuButton onClick={() => handleMenuAction('close')}>Close browser</MenuButton>
            </div>
          ) : null}
        </div>
      </div>

      {showAgentBanner ? (
        <div
          className="flex items-center justify-between gap-2 border-b border-border/30 bg-accent/10 px-2.5 py-1.5 text-caption"
          role="status"
        >
          <span className="text-fg/90">
            {state.userControl ? 'You have control of the browser' : 'Agent is browsing…'}
          </span>
          {state.userControl ? (
            <button
              type="button"
              className="shrink-0 rounded-md border border-border/50 bg-surface px-2 py-0.5 text-2xs font-medium text-fg hover:bg-surface-2"
              onClick={() => void window.vyotiq.browserReleaseControl?.()}
            >
              Return to agent
            </button>
          ) : (
            <button
              type="button"
              className="shrink-0 rounded-md border border-border/50 bg-surface px-2 py-0.5 text-2xs font-medium text-fg hover:bg-surface-2"
              onClick={() => void window.vyotiq.browserTakeControl?.()}
            >
              Take control
            </button>
          )}
        </div>
      ) : null}

      {recentsBar ? (
        <div className="flex items-center gap-1 border-b border-border/30 px-2 py-1 text-caption text-muted">
          <span className="px-1">Recents</span>
          {recents.slice(0, 5).map((item) => (
            <button
              key={`${item.url}-${item.visitedAt}`}
              type="button"
              className="max-w-[7rem] truncate rounded px-1.5 py-0.5 text-fg/80 hover:bg-surface-2"
              title={item.url}
              onClick={() => navigateTo(item.url)}
            >
              {item.title?.trim() || item.url}
            </button>
          ))}
        </div>
      ) : null}

      {loadError ? (
        <div className="px-2.5 py-1 text-caption text-warning" role="alert">
          Browser state unavailable: {loadError}
        </div>
      ) : null}

      {statusMsg ? (
        <div className="px-2.5 py-1 text-caption text-muted" role="status">
          {statusMsg}
        </div>
      ) : null}

      <div
        className={cn(
          'min-h-0 flex-1 bg-bg',
          viewportFitted ? 'relative' : 'flex items-center justify-center overflow-auto p-2'
        )}
      >
      <div
        ref={viewportRef}
        className={cn(
          'relative bg-bg',
          viewportFitted ? 'min-h-0 h-full' : 'shrink-0 overflow-hidden border border-border/40'
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
          <div className="absolute inset-0 overflow-auto px-4 py-6">
            {recents.length > 0 ? (
              <div>
                <p className="mb-2 text-caption font-medium text-muted">Recents</p>
                <ul className="m-0 list-none space-y-1 p-0">
                  {recents.slice(0, 12).map((item) => (
                    <li key={`${item.url}-${item.visitedAt}`}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-fg hover:bg-surface-2"
                        onClick={() => navigateTo(item.url)}
                        title={item.url}
                      >
                        <GlobeGlyph className="shrink-0 text-muted" size={14} />
                        <span className="min-w-0 truncate">
                          {item.title?.trim() || item.url}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                <GlobeGlyph className="mb-4 text-muted/40" size={48} />
                <p className="text-xs font-medium text-fg/80">No page loaded</p>
                <p className="mt-1 max-w-[16rem] text-caption leading-relaxed text-muted">
                  Enter a URL above, or ask the agent to open a page.
                </p>
              </div>
            )}
          </div>
        ) : null}
      </div>
      </div>
    </div>
  )
})

function GlobeGlyph({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

function NavIconButton({
  children,
  label,
  disabled,
  onClick
}: {
  children: React.ReactNode
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className="flex size-7 items-center justify-center rounded-md text-fg/70 vy-transition hover:bg-surface-2 disabled:opacity-[var(--vy-disabled-opacity)]"
        disabled={disabled}
        onClick={onClick}
        aria-label={label}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {children}
        </svg>
      </button>
    </Tooltip>
  )
}

function MenuButton({
  children,
  onClick,
  disabled
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center px-3 py-1.5 text-left text-xs text-fg vy-transition hover:bg-surface-2 disabled:opacity-[var(--vy-disabled-opacity)]"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}
