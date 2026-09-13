import { WebContentsView, session, type WebContents } from 'electron'
import { createHash } from 'crypto'
import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { IPC } from '../../shared/channels'
import { workspacePathsEqual } from '../../shared/workspacePath'
import { getMainWindow } from '@main/app/window'
import { abortError, isAbortError, observePromise } from '../../shared/errors'
import {
  formatInteractiveRefs,
  formatInteractiveRefsWithinBudget,
  parseBrowserTarget,
  type BrowserElementRef
} from './agentBrowserRefs'
import { assertAllowedUrl, isSyncBlockedUrl } from '@main/agent/tools/webFetch'
import {
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  SETTLE_FALLBACK_MS,
  normalizeBrowserUrl
} from './browserUrl'
import { canonicalizeWorkspacePath } from '../../shared/utils/workspacePath'
import { isInsideRoot } from '@main/workspace/safePath'
import { wrapBrowserPageContent } from './browserContentBoundary'
import { getSettings } from '@main/settings/settings'
import { assertBrowserActionAllowed, resolveBrowserUploadPath } from './browserActionPolicy'

export {
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_CHARS,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_NAV_TIMEOUT_MS,
  MAX_TYPE_CHARS,
  MAX_WAIT_TIMEOUT_MS,
  SETTLE_FALLBACK_MS,
  normalizeBrowserUrl
} from './browserUrl'
const SNAPSHOT_JPEG_QUALITY = 55
const PREVIEW_MAX_WIDTH = 960
/**
 * Hard cap on live agent-browser tabs (restored pre-a067d81 behavior). Each
 * tab is a full WebContentsView; unbounded growth exhausts memory/fds.
 * Reuse existing tabs (browser_tabs close / active tab) before opening new ones.
 */
export const MAX_BROWSER_TABS = 16

const PARTITION_PREFIX = 'persist:vyotiq-agent-browser'
const downloadGuardedPartitions = new Set<string>()
const partitionWorkspacePaths = new Map<string, string>()

function partitionForWorkspace(workspacePath?: string): string {
  if (!workspacePath?.trim()) return PARTITION_PREFIX
  const hash = createHash('sha256').update(workspacePath.trim()).digest('hex').slice(0, 16)
  return `${PARTITION_PREFIX}-${hash}`
}

function denyPartitionDownloads(
  ses: Electron.Session,
  partition: string,
  workspacePath?: string
): void {
  if (workspacePath?.trim()) partitionWorkspacePaths.set(partition, workspacePath.trim())
  if (downloadGuardedPartitions.has(partition)) return
  downloadGuardedPartitions.add(partition)
  ses.on('will-download', (event, item) => {
    const decision = assertBrowserActionAllowed('download')
    const destRoot = partitionWorkspacePaths.get(partition)
    if (!decision.allowed || !destRoot || item == null) {
      event.preventDefault()
      return
    }
    const total = item.getTotalBytes()
    if (total > 100 * 1024 * 1024) {
      event.preventDefault()
      return
    }
    const raw = item.getFilename() || 'download'
    const safe =
      basename(raw)
        .split('')
        .map((ch) => {
          const code = ch.charCodeAt(0)
          if (code < 32 || '<>:"/\\|?*'.includes(ch)) return '_'
          return ch
        })
        .join('')
        .slice(0, 180) || 'download'
    const dir = join(destRoot, '.vyotiq', 'downloads')
    mkdirSync(dir, { recursive: true })
    let dest = join(dir, safe)
    let n = 1
    while (existsSync(dest)) {
      dest = join(dir, `${n}-${safe}`)
      n += 1
    }
    item.setSavePath(dest)
  })
}

/** Host allowlist: exact match or `*.example.com` suffix. Empty list = unrestricted. */
export function hostAllowedByAllowlist(hostname: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true
  const host = hostname.toLowerCase().replace(/\.$/, '')
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase().replace(/\.$/, '')
    if (!entry) continue
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2)
      if (host === suffix || host.endsWith(`.${suffix}`)) return true
    } else if (host === entry) {
      return true
    }
  }
  return false
}

function assertDomainAllowlist(url: URL): void {
  const list = getSettings().browserDomainAllowlist ?? []
  if (list.length === 0) return
  if (!hostAllowedByAllowlist(url.hostname, list)) {
    throw new Error(
      `Host "${url.hostname}" is not in browserDomainAllowlist (${list.slice(0, 5).join(', ')}${list.length > 5 ? '…' : ''})`
    )
  }
}

type BrowserTab = {
  id: string
  view: WebContentsView
  lastRefs: Map<string, BrowserElementRef>
  workspacePath?: string
  /**
   * When false (Ask/Plan tool navigations), block private/loopback hosts on
   * navigate and in-page redirects. User/IPC + Agent keep true.
   */
  allowLocalHosts: boolean
}

type EmbedBounds = { x: number; y: number; width: number; height: number }

export type AgentBrowserState = {
  open: boolean
  url: string
  title: string
  /** @deprecated Preview removed — live WebContentsView is embedded in-app. */
  snapshotDataUrl?: string | null
  /** True while a navigation is in flight. */
  navigating?: boolean
  /** True while an agent browser tool holds exclusive control intent. */
  agentBusy?: boolean
  /** True after the user clicked Take control during an agent op. */
  userControl?: boolean
  tabs?: Array<{ id: string; title: string; url: string; active: boolean }>
  canGoBack?: boolean
  canGoForward?: boolean
}

const tabs = new Map<string, BrowserTab>()
/** Tab currently painted in the embedded WebContentsView. */
let visibleTabId: string | null = null
/** Per-workspace active tab for tool ops without explicit tab_id. */
const activeTabIdByWorkspace = new Map<string, string>()
const GLOBAL_WORKSPACE_KEY = '__global__'
let lastState: AgentBrowserState = {
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
/** Serialize all browser ops (agent tools + user IPC) on one shared tab map. */
let browserOpChain: Promise<void> = Promise.resolve()
let tabSeq = 0
let snapshotSeq = 0
let agentBusyDepth = 0
let userTookControl = false
let embedBounds: EmbedBounds | null = null

function workspaceKey(workspacePath?: string): string {
  return workspacePath && workspacePath.length > 0 ? workspacePath : GLOBAL_WORKSPACE_KEY
}

function getActiveTabId(workspacePath?: string): string | null {
  return activeTabIdByWorkspace.get(workspaceKey(workspacePath)) ?? null
}

function setActiveTabId(tabId: string | null, workspacePath?: string): void {
  const key = workspaceKey(workspacePath)
  if (tabId) activeTabIdByWorkspace.set(key, tabId)
  else activeTabIdByWorkspace.delete(key)
}

function clearActiveTabIdForTab(tabId: string): void {
  for (const [key, id] of activeTabIdByWorkspace) {
    if (id === tabId) activeTabIdByWorkspace.delete(key)
  }
}

function tabBelongsToWorkspace(tab: BrowserTab, workspacePath?: string): boolean {
  const key = workspaceKey(workspacePath)
  if (key === GLOBAL_WORKSPACE_KEY) return true
  if (!tab.workspacePath) return false
  return workspacePathsEqual(tab.workspacePath, workspacePath!)
}

/** Resolve an explicit tab id, refusing tabs that are not owned by the workspace. */
function getExistingTab(tabId: string, workspacePath?: string): BrowserTab {
  const existing = tabs.get(tabId)
  if (!existing || isTabDestroyed(existing) || !tabBelongsToWorkspace(existing, workspacePath)) {
    throw new Error(`Unknown browser tab_id: ${tabId}`)
  }
  return existing
}

async function assertPostNavigationPolicy(url: string, allowLocal: boolean): Promise<void> {
  if (!url || url === 'about:blank') return
  const parsed = new URL(url)
  assertDomainAllowlist(parsed)
  if (!allowLocal) {
    await assertAllowedUrl(url, false)
  }
}

function isSyncBlockedNavigation(url: string, allowLocal: boolean): boolean {
  if (isSyncBlockedUrl(url, allowLocal)) return true
  try {
    assertDomainAllowlist(new URL(url))
    return false
  } catch {
    return true
  }
}

type BrowserLockOpts = {
  /** Mark agent-busy for HITL banner / Take control (tool paths). */
  agentControl?: boolean
}

function isTabDestroyed(tab: BrowserTab): boolean {
  try {
    return tab.view.webContents.isDestroyed()
  } catch {
    return true
  }
}

function tabContents(tab: BrowserTab): WebContents {
  return tab.view.webContents
}

function destroyTab(tab: BrowserTab): void {
  const main = getMainWindow()
  if (main && !main.isDestroyed()) {
    try {
      main.contentView.removeChildView(tab.view)
    } catch {
      // already detached
    }
  }
  if (!isTabDestroyed(tab)) {
    tab.view.webContents.close()
  }
  tabs.delete(tab.id)
}

function attachTabView(tab: BrowserTab): void {
  const main = getMainWindow()
  if (!main || main.isDestroyed()) return
  try {
    main.contentView.removeChildView(tab.view)
  } catch {
    // not attached yet
  }
  // Later children paint above the window's main WebContentsView.
  main.contentView.addChildView(tab.view)
}

/** True while the guest must stay live (painted, or an agent browser tool is using it). */
function tabNeedsLiveRenderer(tab: BrowserTab): boolean {
  if (tab.id !== visibleTabId) return false
  const boundsLive = embedBounds != null && embedBounds.width >= 1 && embedBounds.height >= 1
  return boundsLive || agentBusyDepth > 0
}

function applyGuestThrottling(tab: BrowserTab): void {
  if (isTabDestroyed(tab)) return
  try {
    // true = Chromium default (throttle hidden); false = keep the guest awake.
    tab.view.webContents.setBackgroundThrottling(!tabNeedsLiveRenderer(tab))
  } catch {
    // older Electron
  }
}

function applyActiveViewBounds(): void {
  for (const tab of tabs.values()) {
    if (isTabDestroyed(tab)) continue
    const active = tab.id === visibleTabId && tabs.size > 0
    const bounds = embedBounds
    if (!active || !bounds || bounds.width < 1 || bounds.height < 1) {
      tab.view.setVisible(false)
      tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      applyGuestThrottling(tab)
      continue
    }

    attachTabView(tab)
    tab.view.setBounds(bounds)
    tab.view.setVisible(true)
    applyGuestThrottling(tab)
  }
}

export function setAgentBrowserBounds(bounds: EmbedBounds | null): void {
  if (!bounds || bounds.width < 2 || bounds.height < 2) {
    // Keep prior bounds if the renderer reports a transient empty rect during layout.
    if (bounds != null && embedBounds) {
      applyActiveViewBounds()
      return
    }
    embedBounds = null
  } else {
    embedBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    }
  }
  applyActiveViewBounds()
}

function withBrowserLock<T>(
  fn: () => Promise<T>,
  _workspacePath?: string,
  opts: BrowserLockOpts = {}
): Promise<T> {
  const prev = browserOpChain
  const run = prev.then(
    async () => {
      if (opts.agentControl) beginAgentControl()
      try {
        return await fn()
      } finally {
        if (opts.agentControl) endAgentControl()
      }
    },
    async () => {
      if (opts.agentControl) beginAgentControl()
      try {
        return await fn()
      } finally {
        if (opts.agentControl) endAgentControl()
      }
    }
  )
  browserOpChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function beginAgentControl(): void {
  agentBusyDepth += 1
  if (!userTookControl) {
    emitCurrent({ agentBusy: true, userControl: false })
  }
}

function endAgentControl(): void {
  agentBusyDepth = Math.max(0, agentBusyDepth - 1)
  if (agentBusyDepth === 0) {
    userTookControl = false
    emitCurrent({ agentBusy: false, userControl: false })
  } else if (!userTookControl) {
    emitCurrent({ agentBusy: true })
  }
}

/** User Take control — keep live view interactive while agent tools may still run. */
export function takeBrowserControl(): boolean {
  userTookControl = true
  emitCurrent({ agentBusy: false, userControl: true })
  return focusAgentBrowser()
}

/** Clear Take control; next agent op can show busy again. */
export function releaseBrowserControl(): void {
  userTookControl = false
  emitCurrent({
    agentBusy: agentBusyDepth > 0,
    userControl: false
  })
}

function nextTabId(): string {
  tabSeq += 1
  return `t${tabSeq}`
}

function listTabStates(): Array<{ id: string; title: string; url: string; active: boolean }> {
  return [...tabs.values()].map((tab) => {
    const destroyed = isTabDestroyed(tab)
    const wc = destroyed ? null : tabContents(tab)
    return {
      id: tab.id,
      title: wc ? wc.getTitle() : '',
      url: wc ? wc.getURL() : '',
      active: tab.id === getActiveTabId(tab.workspacePath)
    }
  })
}

function navFlags(wc: WebContents | null): { canGoBack: boolean; canGoForward: boolean } {
  if (!wc || wc.isDestroyed()) return { canGoBack: false, canGoForward: false }
  const histWc = wc as WebContents & {
    canGoBack?: () => boolean
    canGoForward?: () => boolean
    navigationHistory?: { canGoBack: () => boolean; canGoForward: () => boolean }
  }
  const hist = histWc.navigationHistory
  if (hist) {
    return { canGoBack: hist.canGoBack(), canGoForward: hist.canGoForward() }
  }
  return {
    canGoBack: typeof histWc.canGoBack === 'function' ? histWc.canGoBack() : false,
    canGoForward: typeof histWc.canGoForward === 'function' ? histWc.canGoForward() : false
  }
}

function pushState(partial: Partial<AgentBrowserState>): void {
  lastState = { ...lastState, ...partial }
  const main = getMainWindow()
  if (!main || main.isDestroyed()) return
  main.webContents.send(IPC.browserState, lastState)
}

function emitCurrent(extra?: Partial<AgentBrowserState>): void {
  const tab = visibleTabId ? tabs.get(visibleTabId) : undefined
  const wc = tab && !isTabDestroyed(tab) ? tabContents(tab) : null
  if (!wc) {
    pushState({
      open: tabs.size > 0,
      url: '',
      title: '',
      navigating: false,
      tabs: listTabStates(),
      canGoBack: false,
      canGoForward: false,
      ...extra
    })
    applyActiveViewBounds()
    return
  }
  const flags = navFlags(wc)
  pushState({
    open: true,
    url: wc.getURL(),
    title: wc.getTitle(),
    tabs: listTabStates(),
    canGoBack: flags.canGoBack,
    canGoForward: flags.canGoForward,
    ...extra
  })
  applyActiveViewBounds()
}

function tabForContents(wc: WebContents): BrowserTab | undefined {
  for (const tab of tabs.values()) {
    if (!isTabDestroyed(tab) && tab.view.webContents === wc) return tab
  }
  return undefined
}

function attachAgentSecurity(wc: WebContents): void {
  const allowLocalFor = (): boolean => tabForContents(wc)?.allowLocalHosts ?? true

  const blockIfNeeded = (event: { preventDefault: () => void }, url: string): void => {
    if (isSyncBlockedNavigation(url, allowLocalFor())) {
      event.preventDefault()
    }
  }

  const verifyLandedUrl = async (): Promise<void> => {
    const tab = tabForContents(wc)
    if (!tab || tab.allowLocalHosts) return
    const landed = wc.getURL()
    if (!landed || landed === 'about:blank') return
    // Workspace-scoped file: pages are legitimate in Ask/Plan tabs — the
    // front door (navigateUrlUnlocked) only admits paths inside the tab's
    // workspace. Skip the http(s) post-navigation policy for them.
    if (landed.startsWith('file:')) {
      const root = tab.workspacePath ? canonicalizeWorkspacePath(tab.workspacePath) : null
      if (root) {
        try {
          const landedUrl = new URL(landed)
          if (!/%5c/i.test(landedUrl.pathname)) {
            const decoded = decodeURIComponent(landedUrl.pathname)
            const rel = decoded.startsWith('/') ? decoded.slice(1) : decoded
            if (isInsideRoot(rel, root)) return
          }
        } catch {
          /* fall through to the generic policy bounce */
        }
      }
    }
    try {
      await assertPostNavigationPolicy(landed, false)
    } catch {
      try {
        const hist = wc as WebContents & { canGoBack?: () => boolean }
        if (typeof hist.canGoBack === 'function' && hist.canGoBack()) {
          wc.goBack()
        } else {
          await wc.loadURL('about:blank')
        }
      } catch {
        /* ignore */
      }
    }
  }

  wc.on('will-navigate', (event, url) => {
    blockIfNeeded(event, url)
  })
  wc.on('will-redirect', (event, url) => {
    blockIfNeeded(event, url)
  })
  wc.on('did-navigate', () => {
    void verifyLandedUrl()
  })
  wc.on('did-navigate-in-page', () => {
    void verifyLandedUrl()
  })

  wc.setWindowOpenHandler(({ url }) => {
    const parentTab = tabForContents(wc)
    const parentWorkspace = parentTab?.workspacePath
    const parentAllow = allowLocalFor()
    if (isSyncBlockedNavigation(url, parentAllow)) return { action: 'deny' }
    if (tabs.size >= MAX_BROWSER_TABS) return { action: 'deny' }
    void withBrowserLock(async () => {
      const tab = createTab(parentWorkspace, parentAllow)
      setActiveTabId(tab.id, parentWorkspace)
      visibleTabId = tab.id
      try {
        await navigateUrlUnlocked(url, {
          tabId: tab.id,
          workspacePath: parentWorkspace,
          allowLocal: parentAllow
        })
      } catch {
        // SSRF / load failure — drop the blank popup tab (do not leave it open).
        destroyTab(tab)
        if (visibleTabId === tab.id) {
          visibleTabId = tabs.keys().next().value ?? null
        }
        clearActiveTabIdForTab(tab.id)
      }
    })
    return { action: 'deny' }
  })
  wc.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  wc.session.setPermissionCheckHandler(() => false)
  // Fallback CSP for browsed pages that ship none of their own. Deliberately
  // minimal so real sites keep working; a page's own CSP is left untouched
  // because multiple policies would only intersect and break it.
  wc.session.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {}
    const hasCsp = Object.keys(headers).some(
      (key) => key.toLowerCase() === 'content-security-policy'
    )
    if (hasCsp) {
      callback({})
      return
    }
    callback({
      responseHeaders: { ...headers, 'Content-Security-Policy': ["object-src 'none'"] }
    })
  })
}

/** Hook alert/confirm/prompt so browser_handle_dialog can accept/dismiss. */
function installDialogHooks(wc: WebContents): void {
  const inject = (): void => {
    void wc
      .executeJavaScript(
        `(() => {
          if (window.__vyotiqDialogHooked) return true
          window.__vyotiqDialogHooked = true
          window.__vyotiqLastDialog = null
          const wrap = (type, orig) => function (message) {
            window.__vyotiqLastDialog = { type: type, message: String(message ?? '') }
            const resp = window.__vyotiqDialogResponse
            if (type === 'alert') return
            if (type === 'confirm') return resp ? !!resp.accept : false
            if (type === 'prompt') return resp && resp.accept ? String(resp.promptText ?? '') : null
            return orig.apply(this, arguments)
          }
          window.alert = wrap('alert', window.alert.bind(window))
          window.confirm = wrap('confirm', window.confirm.bind(window))
          window.prompt = wrap('prompt', window.prompt.bind(window))
          return true
        })()`,
        true
      )
      .catch(() => {
        /* page may not be ready */
      })
  }
  wc.on('dom-ready', inject)
  wc.on('did-finish-load', inject)
}

function createTab(workspacePath?: string, allowLocalHosts = true): BrowserTab {
  const ses = session.fromPartition(partitionForWorkspace(workspacePath))
  denyPartitionDownloads(ses, partitionForWorkspace(workspacePath), workspacePath)
  const id = nextTabId()
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      javascript: true
    }
  })

  attachAgentSecurity(view.webContents)
  installDialogHooks(view.webContents)

  const tab: BrowserTab = {
    id,
    view,
    lastRefs: new Map(),
    workspacePath,
    allowLocalHosts
  }
  tabs.set(id, tab)

  attachTabView(tab)
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  view.setVisible(false)
  applyGuestThrottling(tab)

  view.webContents.on('destroyed', () => {
    tabs.delete(id)
    if (visibleTabId === id) {
      visibleTabId = tabs.keys().next().value ?? null
    }
    clearActiveTabIdForTab(id)
    emitCurrent({ navigating: false })
  })

  view.webContents.on('did-navigate', () => {
    tab.lastRefs = new Map()
    if (visibleTabId === id) emitCurrent()
  })
  view.webContents.on('did-navigate-in-page', () => {
    tab.lastRefs = new Map()
    if (visibleTabId === id) emitCurrent()
  })
  view.webContents.on('page-title-updated', () => {
    if (visibleTabId === id) emitCurrent()
  })

  return tab
}

function ensureTab(tabId?: string, workspacePath?: string): BrowserTab {
  if (tabId) {
    return getExistingTab(tabId, workspacePath)
  }
  const activeId = getActiveTabId(workspacePath)
  if (activeId) {
    const active = tabs.get(activeId)
    if (active && !isTabDestroyed(active) && tabBelongsToWorkspace(active, workspacePath)) {
      return active
    }
  }
  if (tabs.size >= MAX_BROWSER_TABS) {
    throw new Error(
      `Browser tab limit reached (${MAX_BROWSER_TABS}). Close tabs with browser_tabs { action: 'close' } or reuse the active tab before opening another.`
    )
  }
  const tab = createTab(workspacePath)
  setActiveTabId(tab.id, workspacePath)
  return tab
}

function requireTab(tabId?: string, workspacePath?: string): BrowserTab {
  if (tabId) {
    return getExistingTab(tabId, workspacePath)
  }
  const activeId = getActiveTabId(workspacePath)
  if (!activeId) {
    throw new Error('No browser page open. Call browser_navigate or browser_tabs open first.')
  }
  const active = tabs.get(activeId)
  if (!active || isTabDestroyed(active) || !tabBelongsToWorkspace(active, workspacePath)) {
    throw new Error('No browser page open. Call browser_navigate or browser_tabs open first.')
  }
  return active
}

function activateTab(tab: BrowserTab): void {
  visibleTabId = tab.id
  setActiveTabId(tab.id, tab.workspacePath)
  applyActiveViewBounds()
  if (!isTabDestroyed(tab)) {
    tabContents(tab).focus()
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }
}

async function waitForLoad(
  wc: WebContents,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<{ arm: () => void; checkIdle: () => void; done: Promise<void> }> {
  throwIfAborted(signal)
  let armed = false
  let settled = false
  let resolveDone!: () => void
  let rejectDone!: (err: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  // Observe immediately: `did-fail-load` can reject `done` while `loadURL` is
  // still pending, which becomes an unhandledRejection and exits the app.
  observePromise(done)

  const timer = setTimeout(() => {
    finish(() => rejectDone(new Error(`Navigation timed out after ${timeoutMs}ms`)))
  }, timeoutMs)

  const onAbort = (): void => {
    finish(() => {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      rejectDone(err)
    })
  }

  const onDone = (): void => {
    finish(() => resolveDone())
  }

  const onFail = (
    _event: Electron.Event,
    errorCode: number,
    errorDescription: string,
    _validatedURL: string,
    isMainFrame: boolean
  ): void => {
    if (!isMainFrame) return
    // -3 is ABORTED (often from a superseding navigation).
    if (errorCode === -3) return
    if (signal?.aborted) {
      finish(() => rejectDone(abortError()))
      return
    }
    finish(() => rejectDone(new Error(errorDescription || `Navigation failed (${errorCode})`)))
  }

  const finish = (fn: () => void): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    wc.removeListener('did-finish-load', onDone)
    wc.removeListener('did-fail-load', onFail)
    wc.removeListener('did-stop-loading', onDone)
    fn()
  }

  /** Attach listeners before loadURL so fast loads cannot race past us. */
  const arm = (): void => {
    if (armed) return
    armed = true
    signal?.addEventListener('abort', onAbort, { once: true })
    wc.once('did-finish-load', onDone)
    wc.once('did-stop-loading', onDone)
    wc.on('did-fail-load', onFail)
  }

  /** Call after loadURL — resolves if navigation already finished (cache hit). */
  const checkIdle = (): void => {
    if (armed && !settled && !wc.isLoading()) {
      finish(() => resolveDone())
    }
  }

  return { arm, checkIdle, done }
}

/** Navigate the agent browser to an http(s) URL. */
export async function navigateUrl(
  rawUrl: string,
  opts: {
    signal?: AbortSignal
    timeoutMs?: number
    tabId?: string
    workspacePath?: string
    /** When false, refuse private/loopback (Ask/Plan). Default true (Agent/user IPC). */
    allowLocal?: boolean
    /** When true (default), surface agent-busy HITL. User panel should pass false. */
    agentControl?: boolean
  } = {}
): Promise<string> {
  return withBrowserLock(() => navigateUrlUnlocked(rawUrl, opts), opts.workspacePath, {
    agentControl: opts.agentControl !== false
  })
}

async function navigateUrlUnlocked(
  rawUrl: string,
  opts: {
    signal?: AbortSignal
    timeoutMs?: number
    tabId?: string
    workspacePath?: string
    allowLocal?: boolean
  } = {}
): Promise<string> {
  const allowLocal = opts.allowLocal !== false
  const url = normalizeBrowserUrl(rawUrl, { workspaceRoot: opts.workspacePath })
  throwIfAborted(opts.signal)

  if (!allowLocal) {
    await assertAllowedUrl(url.toString(), false)
  }
  if (url.protocol === 'file:') {
    // Front-door only: the containment fence was already enforced by
    // normalizeBrowserUrl; re-verify the decoded path here as defense in
    // depth (and to enforce workspacePath presence on this path too).
    if (!opts.workspacePath) {
      throw new Error('file: URLs must point inside the workspace')
    }
    let landed: string
    try {
      landed = decodeURIComponent(url.pathname)
    } catch {
      throw new Error('file: URLs must point inside the workspace')
    }
    if (/%5c/i.test(url.pathname)) {
      throw new Error('file: URLs must point inside the workspace')
    }
    const inside = isInsideRoot(
      landed.startsWith('/') ? landed.slice(1) : landed,
      canonicalizeWorkspacePath(opts.workspacePath)
    )
    if (!inside) throw new Error('file: URLs must point inside the workspace')
  } else {
    assertDomainAllowlist(url)
  }

  const timeoutMs = Math.max(1_000, opts.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS)

  const tab = ensureTab(opts.tabId, opts.workspacePath)
  tab.allowLocalHosts = allowLocal
  activateTab(tab)
  const wc = tabContents(tab)
  emitCurrent({ navigating: true })

  try {
    const { arm, checkIdle, done } = await waitForLoad(wc, opts.signal, timeoutMs)
    arm()
    const loaded = observePromise(wc.loadURL(url.toString()))
    checkIdle()
    await loaded
    await done
    // DNS-resolved private hosts may pass sync hostname checks — revalidate final URL.
    if (!allowLocal) {
      const landed = wc.getURL()
      if (landed && landed !== 'about:blank') {
        await assertAllowedUrl(landed, false)
      }
    }
  } catch (err) {
    emitCurrent({ navigating: false })
    if (isAbortError(err)) throw err
    throw err
  }

  const finalUrl = wc.getURL()
  tab.lastRefs = new Map()
  emitCurrent({ navigating: false })
  const title = wc.getTitle()
  return [`Navigated to ${finalUrl}`, `Title: ${title || '(none)'}`, `tab_id: ${tab.id}`].join('\n')
}

/** Accessibility text (+ optional JPEG on disk) for the current page. */
export async function snapshotPage(
  opts: {
    signal?: AbortSignal
    maxChars?: number
    runDir?: string
    tabId?: string
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => snapshotPageUnlocked(opts), opts.workspacePath, {
    agentControl: true
  })
}

async function snapshotPageUnlocked(
  opts: {
    signal?: AbortSignal
    maxChars?: number
    runDir?: string
    tabId?: string
    workspacePath?: string
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const wc = tabContents(tab)

  const url = wc.getURL()
  const title = wc.getTitle()

  type SnapshotPayload = {
    text: string
    viewport: { w: number; h: number }
    items: Array<{ selector: string; tag: string; role: string; name: string }>
  }

  const payload = (await wc.executeJavaScript(
    `(() => {
      const cssEscape = (value) => {
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
        return String(value).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\\\\]^\`{|}~])/g, '\\\\$1')
      }
      const cssPath = (el) => {
        if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) {
          return '#' + cssEscape(el.id)
        }
        const testId = el.getAttribute('data-testid')
        if (testId && document.querySelectorAll('[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]').length === 1) {
          return '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]'
        }
        const parts = []
        let node = el
        while (node && node.nodeType === 1 && parts.length < 6) {
          const parent = node.parentElement
          if (!parent) {
            parts.unshift(node.tagName.toLowerCase())
            break
          }
          const tag = node.tagName.toLowerCase()
          const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName)
          const idx = siblings.indexOf(node) + 1
          parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + idx + ')' : tag)
          if (parent === document.body || parent === document.documentElement) {
            parts.unshift(parent.tagName.toLowerCase())
            break
          }
          node = parent
        }
        return parts.join(' > ')
      }
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none') return false
        return true
      }
      const roleOf = (el) => {
        const explicit = el.getAttribute('role')
        if (explicit) return explicit
        const tag = el.tagName.toLowerCase()
        if (tag === 'a') return 'link'
        if (tag === 'button') return 'button'
        if (tag === 'input') {
          const t = (el.getAttribute('type') || 'text').toLowerCase()
          if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button'
          if (t === 'checkbox') return 'checkbox'
          if (t === 'radio') return 'radio'
          if (t === 'range') return 'slider'
          if (t === 'file') return 'button'
          return 'textbox'
        }
        if (tag === 'textarea') return 'textbox'
        if (tag === 'select') return 'combobox'
        if (tag === 'option') return 'option'
        if (tag === 'img') return 'img'
        if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading'
        if (el.isContentEditable) return 'textbox'
        return tag
      }
      const nameOf = (el) => {
        const labelled = el.getAttribute('aria-label')
          || el.getAttribute('placeholder')
          || el.getAttribute('name')
          || el.getAttribute('title')
          || el.getAttribute('alt')
          || (el.labels && el.labels[0] && el.labels[0].innerText)
          || (typeof el.value === 'string' ? el.value : '')
          || el.innerText
          || ''
        return String(labelled).replace(/\\s+/g, ' ').trim().slice(0, 80)
      }
      const selector = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        'summary',
        'option',
        '[role="button"]',
        '[role="link"]',
        '[role="textbox"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="menuitem"]',
        '[role="tab"]',
        '[role="switch"]',
        '[role="option"]',
        '[role="combobox"]',
        '[role="slider"]',
        '[role="spinbutton"]',
        '[role="searchbox"]',
        '[role="heading"]',
        '[contenteditable="true"]',
        'img[alt]',
        '[tabindex]:not([tabindex="-1"])'
      ].join(', ')
      const items = []
      const seen = new Set()
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue
        const path = cssPath(el)
        if (seen.has(path)) continue
        seen.add(path)
        items.push({
          selector: path,
          tag: el.tagName,
          role: roleOf(el),
          name: nameOf(el)
        })
      }
      const title = document.title || ''
      const body = (document.body && (document.body.innerText || document.body.textContent)) || ''
      const text = (title ? title + '\\n\\n' : '') + String(body)
      return {
        text,
        viewport: { w: window.innerWidth || 0, h: window.innerHeight || 0 },
        items
      }
    })()`,
    true
  )) as SnapshotPayload

  throwIfAborted(opts.signal)

  const refs: BrowserElementRef[] = (payload?.items ?? []).map((item, i) => ({
    id: `e${i + 1}`,
    selector: item.selector,
    tag: item.tag,
    role: item.role,
    name: item.name
  }))
  tab.lastRefs = new Map(refs.map((r) => [r.id, r]))

  let imageNote = ''
  try {
    let image = await wc.capturePage()
    const size = image.getSize()
    if (size.width > PREVIEW_MAX_WIDTH) {
      image = image.resize({ width: PREVIEW_MAX_WIDTH, quality: 'better' })
    }
    const jpeg = image.toJPEG(SNAPSHOT_JPEG_QUALITY)
    if (opts.runDir) {
      const rel = writeBrowserScreenshot(opts.runDir, jpeg)
      imageNote = `\n\n[Screenshot saved under run ${rel} (${jpeg.length} bytes)]`
    }
    // Live embed shows the page; JPEG is also loaded in the chat snapshot card.
  } catch (err) {
    imageNote = `\n\n[Screenshot capture failed: ${err instanceof Error ? err.message : String(err)}]`
  }

  const viewport = payload?.viewport
  const viewportLine =
    viewport && viewport.w > 0
      ? `Viewport: ${viewport.w}x${viewport.h}`
      : 'Viewport: (unknown)'
  const header = [
    `URL: ${url}`,
    `Title: ${title || '(none)'}`,
    `tab_id: ${tab.id}`,
    viewportLine,
    '',
    'Interactive elements (use @eN with browser_click / browser_type):'
  ].join('\n')
  const imageReserve = Math.min(180, imageNote.length)
  const maxChars = opts.maxChars
  let refText: string
  let body: string
  if (maxChars != null && Number.isFinite(maxChars) && maxChars > 0) {
    const afterHeader = Math.max(400, maxChars - header.length - imageReserve - 2)
    const refBudget = Math.min(Math.floor(afterHeader * 0.5), afterHeader - 200)
    refText = formatInteractiveRefsWithinBudget(refs, Math.max(64, refBudget)).text
    const bodyBudget = Math.max(200, afterHeader - refText.length - 2)
    body = String(payload?.text ?? '').slice(0, bodyBudget)
  } else {
    refText = formatInteractiveRefs(refs)
    body = String(payload?.text ?? '')
  }

  const raw = `${header}\n${refText}\n\n${body}${imageNote}`
  let origin = 'unknown'
  try {
    origin = url ? new URL(url).origin : 'unknown'
  } catch {
    origin = url || 'unknown'
  }
  return wrapBrowserPageContent(raw, { origin, kind: 'snapshot' })
}

function writeBrowserScreenshot(runDir: string, jpeg: Buffer): string {
  const dir = join(runDir, 'browser')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  snapshotSeq += 1
  const unique = `snapshot-${Date.now()}-${snapshotSeq}.jpg`
  writeFileSync(join(dir, unique), jpeg)
  // Latest alias for IPC/cards that still request browser/snapshot.jpg
  writeFileSync(join(dir, 'snapshot.jpg'), jpeg)
  return `browser/${unique}`
}

type ElementHit = {
  x: number
  y: number
  tag: string
  label: string
  matchIndex: number
  matchCount: number
  css: string
}

const SETTLE_NAV_TIMEOUT_MS = 8_000

type ActionSettleWebContents = Pick<WebContents, 'once' | 'removeListener'>

async function settleAfterAction(
  wc: ActionSettleWebContents,
  signal: AbortSignal | undefined,
  opts: { waitForNav?: boolean; settleMs?: number } = {}
): Promise<void> {
  throwIfAborted(signal)
  const settleMs = Math.max(0, opts.settleMs ?? SETTLE_FALLBACK_MS)
  if (!opts.waitForNav) {
    await new Promise<void>((resolve) => setTimeout(resolve, settleMs))
    throwIfAborted(signal)
    return
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined
    let navTimer: ReturnType<typeof setTimeout> | undefined

    const onDone = (): void => {
      finish(() => resolve())
    }

    const onAbort = (): void => {
      finish(() => {
        const err = new Error('Aborted')
        err.name = 'AbortError'
        reject(err)
      })
    }

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
      if (navTimer !== undefined) clearTimeout(navTimer)
      signal?.removeEventListener('abort', onAbort)
      wc.removeListener('did-finish-load', onDone)
      wc.removeListener('did-navigate-in-page', onDone)
      fn()
    }

    wc.once('did-finish-load', onDone)
    wc.once('did-navigate-in-page', onDone)
    fallbackTimer = setTimeout(onDone, settleMs)
    navTimer = setTimeout(onDone, SETTLE_NAV_TIMEOUT_MS)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function resolveSelector(
  tab: BrowserTab,
  selector: string
): Promise<ElementHit> {
  const wc = tabContents(tab)
  const target = parseBrowserTarget(selector)
  let css = target.kind === 'css' ? target.selector : ''
  if (target.kind === 'ref') {
    const ref = tab.lastRefs.get(target.id)
    if (!ref) {
      throw new Error(
        `Unknown snapshot ref @${target.id}. Call browser_snapshot first and use a listed @eN ref.`
      )
    }
    css = ref.selector
  }

  const hit = (await wc.executeJavaScript(
    `(() => {
      const css = ${JSON.stringify(css)}
      const all = Array.from(document.querySelectorAll(css))
      const interactable = (el) => {
        if (!el || el.nodeType !== 1) return false
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false
        if (Number(style.opacity || '1') === 0) return false
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return false
        return true
      }
      const candidates = all.filter(interactable)
      if (candidates.length === 0) {
        return { error: all.length === 0 ? 'none' : 'hidden', matchCount: all.length }
      }
      const el = candidates[0]
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
      if (typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }) } catch { el.focus() }
      }
      const r = el.getBoundingClientRect()
      const x = Math.round(r.left + r.width / 2)
      const y = Math.round(r.top + r.height / 2)
      const top = document.elementFromPoint(x, y)
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        // Still click the intended element; report overlay for debugging.
      }
      el.classList.add('vyotiq-agent-hit')
      if (!document.getElementById('vyotiq-agent-hit-style')) {
        const style = document.createElement('style')
        style.id = 'vyotiq-agent-hit-style'
        style.textContent = '.vyotiq-agent-hit{outline:2px solid #2563eb !important;outline-offset:2px !important;}'
        document.documentElement.appendChild(style)
      }
      setTimeout(() => { try { el.classList.remove('vyotiq-agent-hit') } catch {} }, 1000)
      const label = (
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('name') ||
        (typeof el.value === 'string' ? el.value : '') ||
        el.innerText ||
        ''
      ).slice(0, 120)
      return {
        x, y,
        tag: el.tagName,
        label: String(label).trim(),
        matchIndex: 0,
        matchCount: candidates.length,
        css
      }
    })()`,
    true
  )) as
    | (ElementHit & { error?: undefined })
    | { error: string; matchCount: number }
    | null

  if (!hit || 'error' in hit) {
    const reason =
      hit && 'error' in hit && hit.error === 'hidden'
        ? `matched ${hit.matchCount} node(s) but none were interactable`
        : 'no matches'
    throw new Error(
      target.kind === 'ref'
        ? `Snapshot ref @${target.id} ${reason} (css=${css})`
        : `No interactable element for selector: ${selector} (${reason})`
    )
  }
  return hit
}

/** Click a CSS-selected element in the agent browser (via mouse input events). */
export async function clickSelector(
  selector: string,
  opts: {
    signal?: AbortSignal
    button?: 'left' | 'right' | 'middle'
    tabId?: string
    settleMs?: number
    workspacePath?: string
    includeSnapshot?: boolean
    runDir?: string
    maxChars?: number
  } = {}
): Promise<string> {
  return withBrowserLock(() => clickSelectorUnlocked(selector, opts), opts.workspacePath, { agentControl: true })
}

async function clickSelectorUnlocked(
  selector: string,
  opts: {
    signal?: AbortSignal
    button?: 'left' | 'right' | 'middle'
    tabId?: string
    workspacePath?: string
    settleMs?: number
    includeSnapshot?: boolean
    runDir?: string
    maxChars?: number
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const sel = String(selector ?? '').trim()
  if (!sel) throw new Error('selector is required')

  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const wc = tabContents(tab)

  const hit = await resolveSelector(tab, sel)
  throwIfAborted(opts.signal)

  const button = opts.button ?? 'left'
  wc.sendInputEvent({
    type: 'mouseDown',
    x: hit.x,
    y: hit.y,
    button,
    clickCount: 1
  })
  wc.sendInputEvent({
    type: 'mouseUp',
    x: hit.x,
    y: hit.y,
    button,
    clickCount: 1
  })

  await settleAfterAction(wc, opts.signal, { waitForNav: true, settleMs: opts.settleMs })
  emitCurrent()
  const label = hit.label ? ` "${hit.label}"` : ''
  const amb =
    hit.matchCount > 1 ? ` (match 1 of ${hit.matchCount} interactable)` : ''
  const base = `Clicked ${hit.tag}${label} at (${hit.x}, ${hit.y}) via ${sel}${amb}`
  return maybeAppendSnapshot(base, opts)
}

async function maybeAppendSnapshot(
  result: string,
  opts: {
    includeSnapshot?: boolean
    signal?: AbortSignal
    tabId?: string
    workspacePath?: string
    runDir?: string
    maxChars?: number
  }
): Promise<string> {
  if (!opts.includeSnapshot) return result
  const snap = await snapshotPageUnlocked({
    signal: opts.signal,
    tabId: opts.tabId,
    workspacePath: opts.workspacePath,
    runDir: opts.runDir,
    maxChars: opts.maxChars
  })
  return `${result}\n\n${snap}`
}

/** Type into the focused element, optionally focusing a CSS selector first. */
export async function typeText(
  text: string,
  opts: {
    signal?: AbortSignal
    selector?: string
    clear?: boolean
    pressEnter?: boolean
    tabId?: string
    settleMs?: number
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => typeTextUnlocked(text, opts), opts.workspacePath, { agentControl: true })
}

async function typeTextUnlocked(
  text: string,
  opts: {
    signal?: AbortSignal
    selector?: string
    clear?: boolean
    pressEnter?: boolean
    tabId?: string
    workspacePath?: string
    settleMs?: number
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const value = String(text ?? '')

  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const wc = tabContents(tab)

  let focusNote = 'active element'
  let cssForFill: string | null = null
  const selector = opts.selector?.trim()
  if (selector) {
    const hit = await resolveSelector(tab, selector)
    throwIfAborted(opts.signal)
    cssForFill = hit.css
    wc.sendInputEvent({
      type: 'mouseDown',
      x: hit.x,
      y: hit.y,
      button: 'left',
      clickCount: 1
    })
    wc.sendInputEvent({
      type: 'mouseUp',
      x: hit.x,
      y: hit.y,
      button: 'left',
      clickCount: 1
    })
    focusNote = `${hit.tag}${hit.label ? ` "${hit.label}"` : ''} (${selector})`
  } else {
    await wc.executeJavaScript(
      `(() => {
        const el = document.activeElement
        if (el && typeof el.focus === 'function') el.focus()
        return true
      })()`,
      true
    )
  }

  throwIfAborted(opts.signal)

  let path = 'insertText'
  if (cssForFill && opts.clear) {
    const filled = (await wc.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(cssForFill)})
        if (!el) return false
        const tag = el.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const proto = tag === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
          const desc = Object.getOwnPropertyDescriptor(proto, 'value')
          if (desc && desc.set) desc.set.call(el, ${JSON.stringify(value)})
          else el.value = ${JSON.stringify(value)}
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return 'value'
        }
        return false
      })()`,
      true
    )) as false | 'value'
    if (filled === 'value') {
      path = 'input.value'
    } else {
      const selectMod = process.platform === 'darwin' ? 'meta' : 'control'
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [selectMod] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [selectMod] })
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
      if (value.length > 0) wc.insertText(value)
    }
  } else {
    if (opts.clear) {
      const selectMod = process.platform === 'darwin' ? 'meta' : 'control'
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [selectMod] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [selectMod] })
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    }
    if (value.length > 0) wc.insertText(value)
  }

  if (opts.pressEnter) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await settleAfterAction(wc, opts.signal, { waitForNav: true, settleMs: opts.settleMs })
  } else {
    await settleAfterAction(wc, opts.signal, { settleMs: opts.settleMs })
  }

  emitCurrent()
  const clearNote = opts.clear ? ', cleared first' : ''
  const enterNote = opts.pressEnter ? ', pressed Enter' : ''
  return `Typed ${value.length} character(s) into ${focusNote}${clearNote}${enterNote} via ${path}`
}

/** Scroll the agent browser page or a target element into view / by deltas. */
export async function scrollPage(
  opts: {
    signal?: AbortSignal
    selector?: string
    deltaX?: number
    deltaY?: number
    tabId?: string
    settleMs?: number
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => scrollPageUnlocked(opts), opts.workspacePath, { agentControl: true })
}

async function scrollPageUnlocked(
  opts: {
    signal?: AbortSignal
    selector?: string
    deltaX?: number
    deltaY?: number
    tabId?: string
    workspacePath?: string
    settleMs?: number
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const wc = tabContents(tab)
  const selector = opts.selector?.trim()
  const dx = Number.isFinite(opts.deltaX) ? Number(opts.deltaX) : 0
  const dy = Number.isFinite(opts.deltaY) ? Number(opts.deltaY) : 0

  if (selector) {
    const hit = await resolveSelector(tab, selector)
    throwIfAborted(opts.signal)
    await settleAfterAction(wc, opts.signal, { settleMs: opts.settleMs })
    emitCurrent()
    return `Scrolled ${hit.tag}${hit.label ? ` "${hit.label}"` : ''} into view (${selector})`
  }

  if (dx === 0 && dy === 0) {
    throw new Error('Provide selector to scroll into view, or deltaX/deltaY to scroll the page')
  }

  await wc.executeJavaScript(
    `window.scrollBy(${dx}, ${dy}); true`,
    true
  )
  await settleAfterAction(wc, opts.signal, { settleMs: opts.settleMs })
  emitCurrent()
  return `Scrolled page by (${dx}, ${dy})`
}

async function setFileInputFiles(wc: WebContents, css: string, filePath: string): Promise<void> {
  const dbg = wc.debugger
  const attached = dbg.isAttached()
  if (!attached) dbg.attach('1.3')
  try {
    await dbg.sendCommand('DOM.enable')
    const { root } = (await dbg.sendCommand('DOM.getDocument', { depth: 0 })) as {
      root: { nodeId: number }
    }
    const { nodeId } = (await dbg.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: css
    })) as { nodeId: number }
    if (!nodeId) throw new Error(`File input not found: ${css}`)
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filePath] })
  } finally {
    if (!attached && dbg.isAttached()) {
      try {
        dbg.detach()
      } catch {
        /* ignore */
      }
    }
  }
}

/** Fill an input/textarea via the value setter (React-friendly) or type into contenteditable. */
export async function fillSelector(
  selector: string,
  value: string,
  opts: {
    signal?: AbortSignal
    pressEnter?: boolean
    tabId?: string
    settleMs?: number
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => fillSelectorUnlocked(selector, value, opts), opts.workspacePath, { agentControl: true })
}

async function fillSelectorUnlocked(
  selector: string,
  value: string,
  opts: {
    signal?: AbortSignal
    pressEnter?: boolean
    tabId?: string
    workspacePath?: string
    settleMs?: number
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const sel = String(selector ?? '').trim()
  if (!sel) throw new Error('selector is required')
  const text = String(value ?? '')

  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const wc = tabContents(tab)

  const hit = await resolveSelector(tab, sel)
  throwIfAborted(opts.signal)

  const inputKind = (await wc.executeJavaScript(
    `(() => {
      const el = document.querySelector(${JSON.stringify(hit.css)})
      if (!el) return 'missing'
      if (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'file') return 'file'
      return 'other'
    })()`,
    true
  )) as string
  if (inputKind === 'file') {
    const abs = resolveBrowserUploadPath(opts.workspacePath ?? tab.workspacePath, text)
    await setFileInputFiles(wc, hit.css, abs)
    await settleAfterAction(wc, opts.signal, { settleMs: opts.settleMs })
    emitCurrent()
    const label = hit.label ? ` "${hit.label}"` : ''
    return `Set file input${label}: ${sel}`
  }

  const result = (await wc.executeJavaScript(
    `(() => {
      const el = document.querySelector(${JSON.stringify(hit.css)})
      if (!el) return { ok: false, reason: 'missing' }
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const proto = tag === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
        const desc = Object.getOwnPropertyDescriptor(proto, 'value')
        if (desc && desc.set) desc.set.call(el, ${JSON.stringify(text)})
        else el.value = ${JSON.stringify(text)}
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true, path: 'value' }
      }
      if (el.isContentEditable) {
        el.focus()
        el.textContent = ${JSON.stringify(text)}
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return { ok: true, path: 'contenteditable' }
      }
      return { ok: false, reason: 'not-fillable' }
    })()`,
    true
  )) as { ok: boolean; path?: string; reason?: string }

  if (!result?.ok) {
    throw new Error(
      result?.reason === 'not-fillable'
        ? `Element is not a fillable input/textarea/contenteditable: ${sel}`
        : `Could not fill selector: ${sel}`
    )
  }

  if (opts.pressEnter) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await settleAfterAction(wc, opts.signal, { waitForNav: true, settleMs: opts.settleMs })
  } else {
    await settleAfterAction(wc, opts.signal, { settleMs: opts.settleMs })
  }

  emitCurrent()
  const label = hit.label ? ` "${hit.label}"` : ''
  return `Filled ${hit.tag}${label} with ${text.length} character(s) via ${result.path} (${sel})`
}

export function focusAgentBrowser(): boolean {
  if (!visibleTabId) return false
  const tab = tabs.get(visibleTabId)
  if (!tab || isTabDestroyed(tab)) return false
  activateTab(tab)
  return true
}

export function closeAgentBrowser(): void {
  for (const tab of [...tabs.values()]) {
    destroyTab(tab)
  }
  tabs.clear()
  visibleTabId = null
  activeTabIdByWorkspace.clear()
  // Keep embedBounds — the chat panel is always visible and will host the next tab.
  pushState({
    open: false,
    url: '',
    title: '',
    navigating: false,
    agentBusy: false,
    userControl: false,
    tabs: [],
    canGoBack: false,
    canGoForward: false
  })
}

/** Close browser tabs owned by a workspace (e.g. when the workspace is removed). */
export function disposeAgentBrowserForWorkspace(workspacePath: string): number {
  const partition = partitionForWorkspace(workspacePath)
  let closed = 0
  for (const tab of [...tabs.values()]) {
    const tabPartition = partitionForWorkspace(tab.workspacePath)
    const owned =
      (tab.workspacePath && workspacePathsEqual(tab.workspacePath, workspacePath)) ||
      tabPartition === partition
    if (!owned) continue
    destroyTab(tab)
    clearActiveTabIdForTab(tab.id)
    closed += 1
  }
  if (visibleTabId && !tabs.has(visibleTabId)) {
    visibleTabId = tabs.keys().next().value ?? null
  }
  emitCurrent({ navigating: false })
  return closed
}

export type BrowserClearKind = 'history' | 'cookies' | 'cache' | 'all'

function clearTabNavigationHistory(workspacePath?: string): void {
  for (const tab of tabs.values()) {
    if (!tabBelongsToWorkspace(tab, workspacePath) || isTabDestroyed(tab)) continue
    const wc = tab.view.webContents
    try {
      if (wc.navigationHistory && typeof wc.navigationHistory.clear === 'function') {
        wc.navigationHistory.clear()
      } else if (typeof wc.clearHistory === 'function') {
        wc.clearHistory()
      }
    } catch {
      /* ignore */
    }
  }
  emitCurrent()
}

/** Clear storage/cache for agent-browser partition(s) used by open tabs (or default). */
export async function clearAgentBrowserData(
  kind: BrowserClearKind,
  workspacePath?: string
): Promise<{ cleared: BrowserClearKind }> {
  const partitions = new Set<string>()
  partitions.add(partitionForWorkspace(workspacePath))
  for (const tab of tabs.values()) {
    if (workspacePath && !tabBelongsToWorkspace(tab, workspacePath)) continue
    partitions.add(partitionForWorkspace(tab.workspacePath))
  }
  const sessions = [...partitions].map((p) => session.fromPartition(p))
  if (kind === 'history' || kind === 'all') {
    // Reset in-tab navigation stacks without destroying live tabs.
    // App-level Recents are cleared in the renderer.
    clearTabNavigationHistory(workspacePath)
  }
  for (const ses of sessions) {
    if (kind === 'cookies') {
      await ses.clearStorageData({ storages: ['cookies'] })
    } else if (kind === 'all') {
      await ses.clearStorageData({
        storages: [
          'cookies',
          'localstorage',
          'indexdb',
          'shadercache',
          'serviceworkers',
          'cachestorage',
          'filesystem'
        ]
      })
    }
    if (kind === 'cache' || kind === 'all') {
      await ses.clearCache()
    }
  }
  return { cleared: kind }
}

/** Capture the active page to `{runDir}/browser/snapshot.jpg`. */
export async function takeBrowserScreenshot(opts: {
  runDir: string
  tabId?: string
  workspacePath?: string
}): Promise<{ path: string }> {
  return withBrowserLock(async () => {
    const tab = requireTab(opts.tabId, opts.workspacePath)
    activateTab(tab)
    const wc = tabContents(tab)
    let image = await wc.capturePage()
    const size = image.getSize()
    if (size.width > PREVIEW_MAX_WIDTH) {
      image = image.resize({ width: PREVIEW_MAX_WIDTH, quality: 'better' })
    }
    const jpeg = image.toJPEG(SNAPSHOT_JPEG_QUALITY)
    const rel = writeBrowserScreenshot(opts.runDir, jpeg)
    return { path: join(opts.runDir, rel) }
  }, opts.workspacePath)
}

export function getAgentBrowserState(): AgentBrowserState {
  return lastState
}

export function selectBrowserTab(tabId: string, workspacePath?: string): boolean {
  const tab = tabs.get(tabId)
  if (!tab || isTabDestroyed(tab) || !tabBelongsToWorkspace(tab, workspacePath)) return false
  activateTab(tab)
  emitCurrent()
  return true
}

export async function browserGoBack(workspacePath?: string): Promise<boolean> {
  try {
    await goBack({ workspacePath })
    return true
  } catch {
    return false
  }
}

export async function browserGoForward(workspacePath?: string): Promise<boolean> {
  try {
    await goForward({ workspacePath })
    return true
  } catch {
    return false
  }
}

/** Test helper — action-settle wait with the same listener/timer cleanup as production. */
export async function settleAfterActionForTests(
  wc: ActionSettleWebContents,
  signal: AbortSignal | undefined,
  opts: { waitForNav?: boolean; settleMs?: number } = {}
): Promise<void> {
  return settleAfterAction(wc, signal, opts)
}

/** Test helper — reset singleton without touching Electron windows. */
export function resetAgentBrowserForTests(): void {
  tabs.clear()
  visibleTabId = null
  activeTabIdByWorkspace.clear()
  downloadGuardedPartitions.clear()
  embedBounds = null
  agentBusyDepth = 0
  userTookControl = false
  snapshotSeq = 0
  lastState = {
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
  browserOpChain = Promise.resolve()
  tabSeq = 0
}

function clampWaitTimeout(timeoutMs?: number): number {
  return Math.max(100, timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
}

export async function manageTabs(
  action: 'list' | 'open' | 'close' | 'select',
  opts: {
    tabId?: string
    url?: string
    signal?: AbortSignal
    workspacePath?: string
    /** When false, refuse private/loopback (Ask/Plan). Default true (Agent/user IPC). */
    allowLocal?: boolean
  } = {}
): Promise<string> {
  return withBrowserLock(() => manageTabsUnlocked(action, opts), opts.workspacePath, {
    agentControl: true
  })
}

async function manageTabsUnlocked(
  action: 'list' | 'open' | 'close' | 'select',
  opts: {
    tabId?: string
    url?: string
    signal?: AbortSignal
    workspacePath?: string
    allowLocal?: boolean
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  if (action === 'list') {
    const rows = listTabStates()
    if (rows.length === 0) return 'No browser tabs open.'
    return rows
      .map((t) => `${t.active ? '*' : ' '} ${t.id}\t${t.title || '(untitled)'}\t${t.url || '(blank)'}`)
      .join('\n')
  }
  if (action === 'open') {
    if (tabs.size >= MAX_BROWSER_TABS) {
      return `Browser tab limit reached (${MAX_BROWSER_TABS}). Close tabs with browser_tabs { action: 'close' } or reuse the active tab before opening another.`
    }
    const allowLocal = opts.allowLocal !== false
    const tab = createTab(opts.workspacePath, allowLocal)
    setActiveTabId(tab.id, opts.workspacePath)
    if (opts.url?.trim()) {
      return await navigateUrlUnlocked(opts.url.trim(), {
        signal: opts.signal,
        tabId: tab.id,
        workspacePath: opts.workspacePath,
        allowLocal
      })
    }
    activateTab(tab)
    emitCurrent()
    return `Opened tab ${tab.id} (blank)`
  }
  if (action === 'select') {
    const id = opts.tabId?.trim()
    if (!id) throw new Error('tab_id is required for browser_tabs select')
    const tab = requireTab(id, opts.workspacePath)
    activateTab(tab)
    emitCurrent()
    return `Selected tab ${tab.id}: ${tabContents(tab).getURL() || '(blank)'}`
  }
  // close
  const id = opts.tabId?.trim() || getActiveTabId(opts.workspacePath)
  if (!id) throw new Error('No tab to close')
  const tab = getExistingTab(id, opts.workspacePath)
  destroyTab(tab)
  emitCurrent()
  return `Closed tab ${id}`
}

export async function goBack(
  opts: {
    tabId?: string
    signal?: AbortSignal
    workspacePath?: string
    allowLocal?: boolean
  } = {}
): Promise<string> {
  return withBrowserLock(() => goHistoryUnlocked('back', opts), opts.workspacePath, { agentControl: true })
}

export async function goForward(
  opts: {
    tabId?: string
    signal?: AbortSignal
    workspacePath?: string
    allowLocal?: boolean
  } = {}
): Promise<string> {
  return withBrowserLock(() => goHistoryUnlocked('forward', opts), opts.workspacePath, { agentControl: true })
}

async function goHistoryUnlocked(
  dir: 'back' | 'forward',
  opts: {
    tabId?: string
    signal?: AbortSignal
    workspacePath?: string
    allowLocal?: boolean
  }
): Promise<string> {
  throwIfAborted(opts.signal)
  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  if (opts.allowLocal !== undefined) tab.allowLocalHosts = opts.allowLocal
  const wc = tabContents(tab)
  const flags = navFlags(wc)
  if (dir === 'back' && !flags.canGoBack) throw new Error('No back history for this tab')
  if (dir === 'forward' && !flags.canGoForward) throw new Error('No forward history for this tab')

  emitCurrent({ navigating: true })
  const { arm, checkIdle, done } = await waitForLoad(wc, opts.signal, DEFAULT_NAV_TIMEOUT_MS)
  arm()
  if (dir === 'back') wc.goBack()
  else wc.goForward()
  checkIdle()
  try {
    await done
  } catch (err) {
    emitCurrent({ navigating: false })
    throw err
  }

  const finalUrl = wc.getURL()
  await assertPostNavigationPolicy(finalUrl, tab.allowLocalHosts)
  tab.lastRefs = new Map()
  emitCurrent({ navigating: false })
  return `Went ${dir} to ${finalUrl}`
}

export async function waitForSelector(
  selector: string,
  opts: { tabId?: string; timeoutMs?: number; signal?: AbortSignal; workspacePath?: string } = {}
): Promise<string> {
  return withBrowserLock(() => waitForSelectorUnlocked(selector, opts), opts.workspacePath, { agentControl: true })
}

async function waitForSelectorUnlocked(
  selector: string,
  opts: { tabId?: string; workspacePath?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const sel = String(selector ?? '').trim()
  if (!sel) throw new Error('selector is required')
  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const timeoutMs = clampWaitTimeout(opts.timeoutMs)
  const deadline = Date.now() + timeoutMs
  let lastErr = 'not found'
  while (Date.now() < deadline) {
    throwIfAborted(opts.signal)
    try {
      const hit = await resolveSelector(tab, sel)
      return `Found ${hit.tag}${hit.label ? ` "${hit.label}"` : ''} via ${sel}`
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for selector: ${sel} (${lastErr})`)
}

export async function waitForUrl(
  match: string,
  opts: {
    tabId?: string
    timeoutMs?: number
    signal?: AbortSignal
    regex?: boolean
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => waitForUrlUnlocked(match, opts), opts.workspacePath, { agentControl: true })
}

async function waitForUrlUnlocked(
  match: string,
  opts: {
    tabId?: string
    workspacePath?: string
    timeoutMs?: number
    signal?: AbortSignal
    regex?: boolean
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const needle = String(match ?? '')
  if (!needle) throw new Error('match is required')
  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const timeoutMs = clampWaitTimeout(opts.timeoutMs)
  const deadline = Date.now() + timeoutMs
  let re: RegExp | null = null
  if (opts.regex) {
    try {
      re = new RegExp(needle)
    } catch {
      throw new Error(`Invalid URL match regex: ${needle}`)
    }
  }
  while (Date.now() < deadline) {
    throwIfAborted(opts.signal)
    const url = tabContents(tab).getURL()
    const ok = re ? re.test(url) : url.includes(needle)
    if (ok) return `URL matched: ${url}`
    await new Promise((r) => setTimeout(r, 100))
  }
  // Best-effort page title, only on the error path (no per-poll cost).
  const title = await tabContents(tab)
    .executeJavaScript('document.title', true)
    .catch(() => null)
  throw new Error(
    formatWaitTimeoutMessage({
      timeoutMs,
      needle,
      regex: opts.regex === true,
      url: tabContents(tab).getURL(),
      title
    })
  )
}

/**
 * Pure formatter for browser_wait_for_url timeout diagnostics.
 * JSON.stringify quoting for url and title; title segment omitted when unavailable.
 */
export function formatWaitTimeoutMessage(input: {
  timeoutMs: number
  needle: string
  regex: boolean
  url: string
  title?: string | null
}): string {
  const matcher = input.regex ? `/${input.needle}/` : JSON.stringify(input.needle)
  const hasTitle = typeof input.title === 'string' && input.title.trim() !== ''
  const titlePart = hasTitle ? `, title: ${JSON.stringify(input.title)}` : ''
  return `Timed out after ${input.timeoutMs}ms waiting for URL matching ${matcher} (last: ${JSON.stringify(input.url)}${titlePart})`
}

export async function pressKey(
  key: string,
  opts: {
    tabId?: string
    modifiers?: string[]
    signal?: AbortSignal
    settleMs?: number
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => pressKeyUnlocked(key, opts), opts.workspacePath, { agentControl: true })
}

async function pressKeyUnlocked(
  key: string,
  opts: {
    tabId?: string
    workspacePath?: string
    modifiers?: string[]
    signal?: AbortSignal
    settleMs?: number
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const keyCode = String(key ?? '').trim()
  if (!keyCode) throw new Error('key is required')
  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const wc = tabContents(tab)
  const modifiers = (opts.modifiers ?? []).map((m) => String(m).toLowerCase()) as Array<
    'command' | 'control' | 'ctrl' | 'shift' | 'alt' | 'meta'
  >
  const normalized = modifiers.map((m) => (m === 'ctrl' ? 'control' : m === 'command' ? 'meta' : m))
  wc.sendInputEvent({
    type: 'keyDown',
    keyCode,
    modifiers: normalized as Electron.InputEvent['modifiers']
  })
  wc.sendInputEvent({
    type: 'keyUp',
    keyCode,
    modifiers: normalized as Electron.InputEvent['modifiers']
  })
  await settleAfterAction(wc, opts.signal, {
    waitForNav: keyCode === 'Return' || keyCode === 'Enter',
    settleMs: opts.settleMs
  })
  emitCurrent()
  const modNote = normalized.length ? ` with ${normalized.join('+')}` : ''
  return `Pressed ${keyCode}${modNote}`
}

export async function selectOption(
  selector: string,
  opts: {
    value?: string
    label?: string
    tabId?: string
    signal?: AbortSignal
    pressEnter?: boolean
    settleMs?: number
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => selectOptionUnlocked(selector, opts), opts.workspacePath, { agentControl: true })
}

async function selectOptionUnlocked(
  selector: string,
  opts: {
    value?: string
    label?: string
    tabId?: string
    workspacePath?: string
    signal?: AbortSignal
    pressEnter?: boolean
    settleMs?: number
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const sel = String(selector ?? '').trim()
  if (!sel) throw new Error('selector is required')
  const value = opts.value
  const label = opts.label
  if ((value == null || value === '') && (label == null || label === '')) {
    throw new Error('Provide value or label for browser_select_option')
  }

  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const wc = tabContents(tab)
  const hit = await resolveSelector(tab, sel)
  throwIfAborted(opts.signal)

  const result = (await wc.executeJavaScript(
    `(() => {
      const el = document.querySelector(${JSON.stringify(hit.css)})
      if (!el || el.tagName !== 'SELECT') return { ok: false, reason: 'not-select' }
      const value = ${JSON.stringify(value ?? null)}
      const label = ${JSON.stringify(label ?? null)}
      let opt = null
      if (value != null) {
        opt = Array.from(el.options).find((o) => o.value === value) || null
      }
      if (!opt && label != null) {
        opt = Array.from(el.options).find((o) => String(o.textContent || '').trim() === label) || null
      }
      if (!opt) return { ok: false, reason: 'no-option' }
      el.value = opt.value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, value: opt.value, label: String(opt.textContent || '').trim() }
    })()`,
    true
  )) as { ok: boolean; reason?: string; value?: string; label?: string }

  if (!result?.ok) {
    throw new Error(
      result?.reason === 'not-select'
        ? `Element is not a <select>: ${sel}`
        : `No matching option for selector: ${sel}`
    )
  }

  if (opts.pressEnter) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await settleAfterAction(wc, opts.signal, { waitForNav: true, settleMs: opts.settleMs })
  } else {
    await settleAfterAction(wc, opts.signal, { settleMs: opts.settleMs })
  }

  emitCurrent()
  return `Selected option "${result.label}" (value=${result.value}) on ${sel}`
}

/** Hover a CSS selector or @eN ref (mouse move to center). */
export async function hoverSelector(
  selector: string,
  opts: {
    signal?: AbortSignal
    tabId?: string
    settleMs?: number
    workspacePath?: string
    includeSnapshot?: boolean
    runDir?: string
    maxChars?: number
  } = {}
): Promise<string> {
  return withBrowserLock(() => hoverSelectorUnlocked(selector, opts), opts.workspacePath, {
    agentControl: true
  })
}

async function hoverSelectorUnlocked(
  selector: string,
  opts: {
    signal?: AbortSignal
    tabId?: string
    workspacePath?: string
    settleMs?: number
    includeSnapshot?: boolean
    runDir?: string
    maxChars?: number
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const sel = String(selector ?? '').trim()
  if (!sel) throw new Error('selector is required')
  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const wc = tabContents(tab)
  const hit = await resolveSelector(tab, sel)
  throwIfAborted(opts.signal)
  wc.sendInputEvent({ type: 'mouseMove', x: hit.x, y: hit.y })
  await settleAfterAction(wc, opts.signal, { settleMs: opts.settleMs ?? SETTLE_FALLBACK_MS })
  emitCurrent()
  const label = hit.label ? ` "${hit.label}"` : ''
  const base = `Hovered ${hit.tag}${label} at (${hit.x}, ${hit.y}) via ${sel}`
  return maybeAppendSnapshot(base, opts)
}

/** Wait until page text contains a substring (or regex). */
export async function waitForText(
  text: string,
  opts: {
    tabId?: string
    timeoutMs?: number
    signal?: AbortSignal
    regex?: boolean
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => waitForTextUnlocked(text, opts), opts.workspacePath, {
    agentControl: true
  })
}

async function waitForTextUnlocked(
  text: string,
  opts: {
    tabId?: string
    workspacePath?: string
    timeoutMs?: number
    signal?: AbortSignal
    regex?: boolean
  } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const needle = String(text ?? '')
  if (!needle) throw new Error('text is required')
  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const wc = tabContents(tab)
  const timeoutMs = clampWaitTimeout(opts.timeoutMs)
  const deadline = Date.now() + timeoutMs
  let re: RegExp | null = null
  if (opts.regex) {
    try {
      re = new RegExp(needle)
    } catch {
      throw new Error(`Invalid text match regex: ${needle}`)
    }
  }
  while (Date.now() < deadline) {
    throwIfAborted(opts.signal)
    const body = (await wc.executeJavaScript(
      `(() => (document.body && (document.body.innerText || document.body.textContent)) || '')()`,
      true
    )) as string
    const hay = String(body ?? '')
    const ok = re ? re.test(hay) : hay.includes(needle)
    if (ok) {
      return wrapBrowserPageContent(`Text matched on page (length=${hay.length})`, {
        origin: (() => {
          try {
            return new URL(wc.getURL()).origin
          } catch {
            return wc.getURL() || 'unknown'
          }
        })(),
        kind: 'wait_for_text'
      })
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for text ${opts.regex ? '/' + needle + '/' : JSON.stringify(needle)}`
  )
}

/** Set accept/dismiss for the next alert/confirm/prompt (hooked page dialogs). */
export async function handleDialog(
  action: 'accept' | 'dismiss',
  opts: {
    promptText?: string
    signal?: AbortSignal
    tabId?: string
    workspacePath?: string
  } = {}
): Promise<string> {
  return withBrowserLock(() => handleDialogUnlocked(action, opts), opts.workspacePath, {
    agentControl: true
  })
}

async function handleDialogUnlocked(
  action: 'accept' | 'dismiss',
  opts: { promptText?: string; signal?: AbortSignal; tabId?: string; workspacePath?: string } = {}
): Promise<string> {
  throwIfAborted(opts.signal)
  const tab = requireTab(opts.tabId, opts.workspacePath)
  activateTab(tab)
  const wc = tabContents(tab)
  await wc.executeJavaScript(
    `(() => {
      window.__vyotiqDialogResponse = {
        accept: ${action === 'accept' ? 'true' : 'false'},
        promptText: ${JSON.stringify(opts.promptText ?? '')}
      }
      const last = window.__vyotiqLastDialog
      return last ? { type: last.type, message: last.message } : null
    })()`,
    true
  )
  const last = (await wc.executeJavaScript(
    `(() => window.__vyotiqLastDialog || null)()`,
    true
  )) as { type?: string; message?: string } | null
  emitCurrent()
  if (last?.type) {
    return `Dialog handler set to ${action} (last seen: ${last.type}: ${String(last.message ?? '').slice(0, 120)})`
  }
  return `Dialog handler set to ${action} (will apply to next alert/confirm/prompt)`
}

/** Run ops through the global browser mutex (unit tests). */
export async function runWithBrowserMutexForTests<T>(
  ops: Array<() => Promise<T>>
): Promise<T[]> {
  return Promise.all(ops.map((op) => withBrowserLock(op)))
}

export { isSyncBlockedNavigation }
