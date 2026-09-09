import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { cn } from '@renderer/lib/ui'
import { copyText } from '@renderer/lib/markdown/copyText'
import { CHAT_RIGHT_PANEL_BODY } from '@renderer/lib/utils/layout'
import type { PtySessionInfo } from '@shared/ipc'
import { prunePtyOutputBuffers } from '@shared/utils/ptyOutputBuffer'
import { getPtyOutputBuffers, ensurePtyOutputBufferListener } from './ptyOutputBuffers'
import { EmptyPanel } from './PanelChrome'
import { TerminalSessionBar } from './TerminalSessionBar'

ensurePtyOutputBufferListener()

function readCssColor(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return value || fallback
}

function readTerminalTheme(): ITheme {
  return {
    background: readCssColor('--vy-bg', '#000000'),
    foreground: readCssColor('--vy-fg', '#f5f5f5'),
    cursor: readCssColor('--vy-fg', '#f5f5f5'),
    selectionBackground: readCssColor('--vy-surface-2', '#262626'),
    black: readCssColor('--vy-bg', '#000000'),
    brightBlack: readCssColor('--vy-tertiary', '#6b7280')
  }
}

/** One xterm host bound to a PTY session id. */
function PtySessionView({
  sessionId,
  workspacePath,
  visible,
  focused = true
}: {
  sessionId: string
  workspacePath: string
  /** When false (CSS-hidden dock tab), do not steal composer focus. */
  visible: boolean
  /** In split mode, only the focused pane should call term.focus(). */
  focused?: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  useEffect(() => {
    const el = hostRef.current
    if (!el) return undefined

    // screenReaderMode builds a parallel DOM mirror on every write — expensive.
    // Default follows real assistive-tech detection; users can force on/off.
    let srPref: 'auto' | 'on' | 'off' = 'auto'
    let atDetected = false
    const applyScreenReaderMode = (): void => {
      if (term.options) term.options.screenReaderMode = srPref === 'on' || (srPref === 'auto' && atDetected)
    }

    const term = new Terminal({
      convertEol: true,
      fontFamily: readCssColor('--vy-font-mono', '"JetBrains Mono", ui-monospace, monospace'),
      fontSize: 12,
      theme: readTerminalTheme(),
      screenReaderMode: true
    })
    applyScreenReaderMode()
    void window.vyotiq?.getSettings?.().then((res) => {
      if (!res.ok) return
      const pref = res.data.terminalScreenReader ?? 'auto'
      if (pref === 'on' || pref === 'off') srPref = pref
      applyScreenReaderMode()
    })
    const unsubA11y = window.vyotiq?.onAccessibilitySupportChanged?.(({ enabled }) => {
      atDetected = enabled
      applyScreenReaderMode()
    })
    void window.vyotiq?.getAccessibilitySupportState?.().then((res) => {
      if (res.ok) {
        atDetected = res.data.enabled
        applyScreenReaderMode()
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    // xterm ships no copy/paste keybindings — Ctrl/Cmd+C with a selection copies
    // instead of sending ^C, and Ctrl/Cmd+V pastes the clipboard, like VS Code /
    // Windows Terminal.
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey
      ) {
        const key = event.key.toLowerCase()
        if (key === 'c' && term.hasSelection()) {
          void copyText(term.getSelection())
          return false
        }
        if (key === 'v') {
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (text) term.paste(text)
            })
            .catch(() => {
              // Clipboard permission denied — let xterm's default paste handling apply.
            })
          return false
        }
      }
      return true
    })
    term.open(el)
    termRef.current = term
    fitRef.current = fit

    // Subscribe before replaying buffer so mid-gap chunks land in the buffer
    // (global listener) and are included in the replay — not dropped.
    let replayDone = false
    const unsubData = window.vyotiq?.onPtyData?.(({ id, data }) => {
      if (id !== sessionId) return
      if (!replayDone) return
      term.write(data)
    })
    const buffers = getPtyOutputBuffers()
    const buffered = buffers.get(sessionId)
    if (buffered) term.write(buffered)
    replayDone = true

    // Only focus when this dock tab is the visible focused pane — mounting while
    // CSS-hidden (auto-open + another panel active) must not steal composer focus.
    if (visibleRef.current && focusedRef.current) term.focus()

    const applyFit = (): void => {
      if (!visibleRef.current) return
      if (el.clientWidth < 2 || el.clientHeight < 2) return
      try {
        fit.fit()
        if (term.cols >= 2 && term.rows >= 2) {
          void window.vyotiq?.ptyResize?.(sessionId, term.cols, term.rows, workspacePath)
        }
      } catch {
        /* ignore */
      }
    }

    // Coalesce resize storms: at most one fit()+ptyResize IPC per animation frame.
    let fitFrame = 0
    const scheduleFit = (): void => {
      if (fitFrame) return
      fitFrame = requestAnimationFrame(() => {
        fitFrame = 0
        applyFit()
      })
    }

    const onData = term.onData((data) => {
      void window.vyotiq?.ptyWrite?.(sessionId, data, workspacePath)
    })

    const unsubExit = window.vyotiq?.onPtyExit?.(({ id }) => {
      if (id !== sessionId) return
      term.writeln('\r\n[process exited]')
    })

    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleFit()) : null
    ro?.observe(el)

    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTerminalTheme()
      term.options.fontFamily = readCssColor(
        '--vy-font-mono',
        '"JetBrains Mono", ui-monospace, monospace'
      )
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-skin']
    })

    applyFit()

    return () => {
      onData.dispose()
      unsubData?.()
      unsubExit?.()
      unsubA11y?.()
      if (fitFrame) cancelAnimationFrame(fitFrame)
      ro?.disconnect()
      themeObserver.disconnect()
      termRef.current = null
      fitRef.current = null
      term.dispose()
    }
  }, [sessionId, workspacePath])

  useEffect(() => {
    if (!visible) return
    const term = termRef.current
    const fit = fitRef.current
    const el = hostRef.current
    if (!term || !fit || !el) return
    // Double rAF: CSS-hidden → visible layout may not have final size on the first frame.
    let cancelled = false
    const frame1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return
        try {
          if (el.clientWidth >= 2 && el.clientHeight >= 2) {
            fit.fit()
            if (term.cols >= 2 && term.rows >= 2) {
              void window.vyotiq?.ptyResize?.(sessionId, term.cols, term.rows, workspacePath)
            }
          }
          if (focusedRef.current) term.focus()
        } catch {
          /* ignore */
        }
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame1)
    }
  }, [visible, focused, sessionId, workspacePath])

  return (
    <div
      ref={hostRef}
      className="h-full w-full bg-bg"
      data-pty-host
      role="application"
      aria-label="Terminal session"
      aria-describedby="terminal-screen-reader-hint"
      tabIndex={0}
    />
  )
}

/**
 * Interactive user PTY terminal panel (VS Code–style).
 * Agent `terminal` tool output stays in the chat transcript — this dock is not
 * wired to agent tools and must not auto-open on agent activity.
 */
export function TerminalPanel({
  className,
  workspacePath,
  visible = true,
  sessionBarHostRef,
  onSessionsChange,
  onActiveSessionChange
}: {
  className?: string
  workspacePath?: string | null
  /** False while the terminal dock tab is CSS-hidden. */
  visible?: boolean
  /** When set, session tabs render in the dock tab bar instead of inside the panel. */
  sessionBarHostRef?: React.RefObject<HTMLElement | null>
  onSessionsChange?: (sessions: PtySessionInfo[]) => void
  onActiveSessionChange?: (session: PtySessionInfo | null) => void
}) {
  const [sessions, setSessions] = useState<PtySessionInfo[]>([])
  const listSeqRef = useRef(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  /** Second pane session id for side-by-side split; null = single pane. */
  const [splitId, setSplitId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Gate auto-create until ptyList has returned (avoids duplicate sessions on remount). */
  const [listReady, setListReady] = useState(false)
  const autoCreateAttemptedRef = useRef(false)
  /** After the user closes the last session, do not immediately spawn another. */
  const suppressAutoCreateRef = useRef(false)
  const onSessionsChangeRef = useRef(onSessionsChange)
  onSessionsChangeRef.current = onSessionsChange
  const onActiveSessionChangeRef = useRef(onActiveSessionChange)
  onActiveSessionChangeRef.current = onActiveSessionChange

  const usingPipeFallback = sessions.some((s) => s.backend === 'pipe')
  const activeSession = sessions.find((s) => s.id === activeId) ?? null

  useEffect(() => {
    onActiveSessionChangeRef.current?.(activeSession)
  }, [activeSession])

  const refreshList = useCallback(async () => {
    const seq = ++listSeqRef.current
    if (!window.vyotiq?.ptyList) {
      if (seq !== listSeqRef.current) return
      setError('Terminal IPC unavailable.')
      setListReady(true)
      return
    }
    const boundWorkspace = workspacePath
    const res = await window.vyotiq.ptyList(boundWorkspace ?? undefined)
    if (seq !== listSeqRef.current) return
    if (!res?.ok) {
      setError(res?.error ?? 'Terminal list failed.')
      setListReady(true)
      return
    }
    // Keep prior create/IPC errors visible when the list is empty so a failed
    // auto-create is not silently replaced by the empty-state copy alone.
    if (res.data.length > 0) setError(null)
    prunePtyOutputBuffers(
      getPtyOutputBuffers(),
      res.data.map((s) => s.id)
    )
    setSessions(res.data)
    onSessionsChangeRef.current?.(res.data)
    setActiveId((cur) => {
      if (cur && res.data.some((s) => s.id === cur)) return cur
      return res.data[0]?.id ?? null
    })
    setSplitId((cur) => {
      if (!cur) return null
      if (!res.data.some((s) => s.id === cur)) return null
      return cur
    })
    setListReady(true)
  }, [workspacePath])

  const createSession = useCallback(async (): Promise<string | null> => {
    if (!workspacePath) {
      setError('Open a workspace to start a terminal.')
      return null
    }
    if (!window.vyotiq?.ptyCreate) {
      setError('Terminal IPC unavailable.')
      return null
    }
    setError(null)
    suppressAutoCreateRef.current = false
    const res = await window.vyotiq.ptyCreate({ workspacePath, cols: 80, rows: 24 })
    if (!res.ok) {
      setError(res.error || 'Failed to create terminal session.')
      return null
    }
    await refreshList()
    setActiveId(res.data.id)
    return res.data.id
  }, [workspacePath, refreshList])

  const killSession = useCallback(
    async (id: string) => {
      if (!workspacePath) return
      if (sessions.length <= 1) {
        suppressAutoCreateRef.current = true
      }
      const res = await window.vyotiq?.ptyKill?.(id, workspacePath)
      if (res && !res.ok) setError(res.error)
      getPtyOutputBuffers().delete(id)
      if (splitId === id) setSplitId(null)
      await refreshList()
    },
    [refreshList, sessions.length, splitId, workspacePath]
  )

  const toggleSplit = useCallback(async () => {
    if (splitId) {
      setSplitId(null)
      return
    }
    if (!activeId) {
      const created = await createSession()
      if (!created) return
      const other = await createSession()
      if (other) {
        setActiveId(created)
        setSplitId(other)
      }
      return
    }
    const other = sessions.find((s) => s.id !== activeId)
    if (other) {
      setSplitId(other.id)
      return
    }
    const created = await createSession()
    if (created && created !== activeId) {
      setSplitId(created)
      setActiveId(activeId)
    }
  }, [splitId, activeId, sessions, createSession])

  useEffect(() => {
    autoCreateAttemptedRef.current = false
    suppressAutoCreateRef.current = false
    setListReady(false)
    setSessions([])
    setActiveId(null)
    setSplitId(null)
    setError(null)
  }, [workspacePath])

  useEffect(() => {
    void refreshList()
    return () => {
      listSeqRef.current += 1
    }
  }, [refreshList])

  // Auto-create only when the dock tab is visible (manual open / focused tab).
  // Scrollback for live sessions is restored from ptyOutputBuffers on remount.
  useEffect(() => {
    if (!visible) return
    if (!listReady) return
    if (sessions.length > 0) return
    if (!workspacePath || autoCreateAttemptedRef.current || suppressAutoCreateRef.current) {
      return
    }
    autoCreateAttemptedRef.current = true
    void createSession()
  }, [visible, listReady, sessions.length, workspacePath, createSession])

  // Buffering is owned by ptyOutputBuffers.ts (survives unmount). Panel only
  // refreshes the session list when a process exits.
  useEffect(() => {
    const unsubExit = window.vyotiq?.onPtyExit?.(() => {
      void refreshList()
    })
    return () => {
      unsubExit?.()
    }
  }, [refreshList])

  const [sessionBarHost, setSessionBarHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!sessionBarHostRef || !visible) {
      setSessionBarHost(null)
      return
    }
    let cancelled = false
    const attach = (): void => {
      if (cancelled) return
      const host = sessionBarHostRef.current
      if (host) {
        setSessionBarHost(host)
        return
      }
      requestAnimationFrame(attach)
    }
    attach()
    return () => {
      cancelled = true
    }
  }, [sessionBarHostRef, visible, sessions.length])

  const useExternalSessionBar = Boolean(sessionBarHostRef)
  const showExternalSessionBar = useExternalSessionBar && visible && sessionBarHost != null

  const sessionBar = (
    <TerminalSessionBar
      sessions={sessions}
      activeId={activeId}
      splitId={splitId}
      onSelect={(id) => {
        // Selecting the secondary split pane: swap roles so split stays open.
        if (splitId && id === splitId && activeId && id !== activeId) {
          setSplitId(activeId)
          setActiveId(id)
          return
        }
        setActiveId(id)
      }}
      onKill={(id) => void killSession(id)}
      onCreate={() => void createSession()}
      onToggleSplit={() => void toggleSplit()}
    />
  )

  return (
    <div
      className={cn(CHAT_RIGHT_PANEL_BODY, className)}
      data-terminal-panel
      role="region"
      aria-label="Terminal panel"
      aria-describedby="terminal-screen-reader-hint"
    >
      <p id="terminal-screen-reader-hint" className="sr-only">
        Interactive terminal. Screen reader users can press Control plus backtick to review terminal
        output in a text buffer.
      </p>
      {showExternalSessionBar
        ? createPortal(sessionBar, sessionBarHost)
        : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {!useExternalSessionBar ? (
          <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/40 bg-bg px-1 py-0.5">
            {sessionBar}
          </div>
        ) : null}
        {error ? (
          <p
            className="m-0 shrink-0 border-b border-border/40 px-3 py-1 text-caption text-danger"
            data-terminal-error
            role="alert"
          >
            {error}
          </p>
        ) : null}
        {usingPipeFallback ? (
          <p className="m-0 shrink-0 border-b border-border/40 px-3 py-1 text-caption text-muted">
            Pipe shell fallback — rebuild node-pty for Electron for a full interactive PTY.
          </p>
        ) : null}
        <div className="relative min-h-0 min-w-0 flex-1 bg-bg p-1">
          {activeId && workspacePath ? (
            splitId && splitId !== activeId ? (
              <div className="flex h-full min-h-0 w-full gap-1">
                <div className="min-h-0 min-w-0 flex-1">
                  <PtySessionView
                    sessionId={activeId}
                    workspacePath={workspacePath}
                    visible={visible}
                    focused={visible}
                  />
                </div>
                <div className="w-px shrink-0 bg-border/50" />
                <div className="min-h-0 min-w-0 flex-1">
                  <PtySessionView
                    sessionId={splitId}
                    workspacePath={workspacePath}
                    visible={visible}
                    focused={false}
                  />
                </div>
              </div>
            ) : (
              <PtySessionView
                sessionId={activeId}
                workspacePath={workspacePath}
                visible={visible}
                focused={visible}
              />
            )
          ) : (
            <EmptyPanel
              icon="terminal"
              title="No terminal"
              body={
                workspacePath
                  ? 'Use New terminal above to start an interactive shell.'
                  : 'Open a workspace to start an interactive shell.'
              }
            />
          )}
        </div>
      </div>
    </div>
  )
}
