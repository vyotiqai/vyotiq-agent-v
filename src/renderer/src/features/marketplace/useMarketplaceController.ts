import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MarketplaceCatalogEntry,
  MarketplaceIndex,
  MarketplaceInstalledItem,
  MarketplaceInstallRequest,
  McpApplyDetectedRequest,
  McpApplyDetectedResult,
  McpDetectResult,
  McpImportExternalRequest,
  McpImportExternalResult,
  McpServer,
  McpServerStatus,
  Settings,
  LocalSkillItem,
  ToolCatalogResult,
  WorkspaceSettingsOverride
} from '@shared/ipc'
import type { MarketplaceOverrideKind } from '@shared/domain/marketplaceEnablement'
import { findByWorkspacePath } from '@shared/workspacePathMatch'
import { pushToast } from '@renderer/lib/ui'
import { indexMcpStatusById } from './mcpStatus'
import type { ProjectRuleItem } from './extensionItems'

const REMOTE_INSTALL_SOURCES = new Set(['registry', 'git', 'npm', 'zip', 'remote', 'path'])
/** How often to look again while a server is still dialling, and for how long. */
const CONNECTING_POLL_MS = 1500
const CONNECTING_POLL_MAX = 40

export type Outcome<T = undefined> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Does the freshly installed server still need credentials?
 *
 * Read from main rather than the caller's `settings` prop, which is captured at
 * render and is stale by the time an install finishes. Returns false when the
 * lookup fails so a transient IPC error cannot pop a dialog for a package that
 * connects on its own.
 */
async function serverNeedsConnect(
  serverId: string,
  workspacePath: string | null
): Promise<boolean> {
  try {
    const latest = await window.vyotiq.getSettings()
    if (!latest.ok) return false
    const auth = latest.data.mcpServers.find((s) => s.id === serverId)?.auth
    if (auth !== 'oauth' && auth !== 'oauth-client' && auth !== 'token') return false
    // Declaring an auth kind is not the same as still needing one. GitHub MCP
    // reuses the app's own GitHub sign-in, so it can arrive already connected
    // — and putting a credential dialog in front of someone who has nothing
    // left to supply is the step this whole flow exists to remove.
    const status = await window.vyotiq.mcpStatus({ workspacePath })
    if (!status.ok) return true
    const row = status.data.servers.find((s) => s.id === serverId)
    return !(row?.connected || row?.hasAuthToken)
  } catch {
    // The install itself already succeeded; failing to decide whether to offer
    // the connect dialog must not turn that into a failed install.
    return false
  }
}

export function useMarketplaceController({
  settings,
  onUpdate,
  onReloadSettings,
  activeWorkspacePath,
  settingsOverridesByPath,
  onSetSettingsOverride
}: {
  settings: Settings
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Reload settings from main after marketplace mutations that write mcpServers on disk. */
  onReloadSettings?: () => Promise<void>
  activeWorkspacePath?: string | null
  settingsOverridesByPath?: Record<string, WorkspaceSettingsOverride>
  onSetSettingsOverride?: (
    path: string,
    override: WorkspaceSettingsOverride | null
  ) => Promise<{ ok: true } | { ok: false; error: string }>
}) {
  const workspacePath = activeWorkspacePath ?? null
  const [catalog, setCatalog] = useState<MarketplaceCatalogEntry[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [installed, setInstalled] = useState<MarketplaceIndex>({ schemaVersion: 1, items: [] })
  const [localSkills, setLocalSkills] = useState<LocalSkillItem[]>([])
  const [projectRules, setProjectRules] = useState<ProjectRuleItem[]>([])
  const [toolCatalog, setToolCatalog] = useState<ToolCatalogResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [busyTargetId, setBusyTargetId] = useState<string | null>(null)
  const busyDepthRef = useRef(0)
  const beginBusy = useCallback((targetId?: string | null) => {
    busyDepthRef.current += 1
    if (busyDepthRef.current === 1) setBusy(true)
    if (targetId != null) setBusyTargetId(targetId)
  }, [])
  const endBusy = useCallback(() => {
    busyDepthRef.current = Math.max(0, busyDepthRef.current - 1)
    if (busyDepthRef.current === 0) {
      setBusy(false)
      setBusyTargetId(null)
    }
  }, [])
  const [saving, setSaving] = useState(false)
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus[]>([])
  const [mcpStatusLoaded, setMcpStatusLoaded] = useState(false)
  const [hasGoogleMcpClientSecret, setHasGoogleMcpClientSecret] = useState(false)
  /** A user-configured or app-bundled Google OAuth client exists. */
  const [hasGoogleMcpClient, setHasGoogleMcpClient] = useState(false)
  const [connectWizardId, setConnectWizardId] = useState<string | null>(null)
  const mcpStatusReqIdRef = useRef(0)
  const reloadReqIdRef = useRef(0)
  const toolCatalogReqIdRef = useRef(0)
  const connectingPollsRef = useRef(0)

  const mcpStatusById = useMemo(
    () => indexMcpStatusById(mcpStatus, settings.mcpServers),
    [mcpStatus, settings.mcpServers]
  )

  const workspaceOverride = useMemo(
    () =>
      workspacePath && settingsOverridesByPath
        ? findByWorkspacePath(settingsOverridesByPath, workspacePath)
        : undefined,
    [workspacePath, settingsOverridesByPath]
  )

  const formLocked = busy || saving

  /**
   * `true` reconnects every server (Reconnect all), `'failed'` tries again only
   * for the ones that failed, and the default just reads status.
   */
  const loadMcpStatus = useCallback(
    async (refresh: boolean | 'failed' = false): Promise<void> => {
      if (!window.vyotiq.mcpStatus) return
      const reqId = ++mcpStatusReqIdRef.current
      const payload = { workspacePath }
      const res =
        refresh && window.vyotiq.mcpRefresh
          ? await window.vyotiq.mcpRefresh(
              refresh === 'failed' ? { ...payload, failedOnly: true } : payload
            )
          : await window.vyotiq.mcpStatus(payload)
      if (reqId !== mcpStatusReqIdRef.current) return
      if (res.ok) {
        setMcpStatus(res.data.servers)
        setHasGoogleMcpClientSecret(res.data.hasGoogleMcpClientSecret === true)
        setHasGoogleMcpClient(res.data.hasGoogleMcpClient === true)
        setMcpStatusLoaded(true)
      } else {
        pushToast(res.code ? `${res.error} (${res.code})` : res.error, 'error')
      }
    },
    [workspacePath]
  )

  /**
   * The catalog main pushes on a change is for the active workspace; this view
   * may be scoped to another, so it asks again for its own.
   */
  const loadToolCatalog = useCallback(async (): Promise<void> => {
    if (!window.vyotiq.toolsCatalogGet) return
    const reqId = ++toolCatalogReqIdRef.current
    try {
      const res = await window.vyotiq.toolsCatalogGet({ workspacePath })
      if (reqId === toolCatalogReqIdRef.current && res.ok) setToolCatalog(res.data)
    } catch {
      // The tool list is a detail; a failed read leaves the last one standing.
    }
  }, [workspacePath])

  const runUpdate = useCallback(
    async (partial: Partial<Settings>): Promise<boolean> => {
      setSaving(true)
      try {
        const res = await onUpdate(partial)
        if (!res.ok) {
          pushToast(res.error, 'error')
          return false
        }
        return true
      } finally {
        setSaving(false)
      }
    },
    [onUpdate]
  )

  const reload = useCallback(async () => {
    const reqId = ++reloadReqIdRef.current
    setCatalogLoading(true)
    try {
      // The whole catalog: search and the tabs filter it here, so the counts
      // on every tab stay honest while one of them is open.
      const [browseRes, installedRes, localRes] = await Promise.all([
        window.vyotiq.marketplaceBrowse({}),
        window.vyotiq.marketplaceListInstalled(),
        window.vyotiq.skillsListLocal
          ? window.vyotiq.skillsListLocal({ workspacePath })
          : Promise.resolve({ ok: true as const, data: { skills: [] as LocalSkillItem[] } })
      ])
      if (reqId !== reloadReqIdRef.current) return
      if (browseRes.ok) setCatalog(browseRes.data.packages)
      else pushToast(browseRes.error, 'error')
      if (installedRes.ok) setInstalled(installedRes.data)
      else pushToast(installedRes.error, 'error')
      if (localRes.ok) setLocalSkills(localRes.data.skills)
      else pushToast(localRes.error, 'error')
    } finally {
      if (reqId === reloadReqIdRef.current) setCatalogLoading(false)
    }
  }, [workspacePath])

  const loadProjectRules = useCallback(async (): Promise<void> => {
    if (!workspacePath || !window.vyotiq.workspaceListRules) {
      setProjectRules([])
      return
    }
    const res = await window.vyotiq.workspaceListRules({ workspacePath })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return
    }
    setProjectRules(res.data.rules)
  }, [workspacePath])

  const refreshCatalog = useCallback(async () => {
    setCatalogLoading(true)
    try {
      const registryUrl = (settings.marketplace?.registryUrl ?? '').trim()
      if (registryUrl && window.vyotiq.marketplaceRefreshCatalog) {
        const refreshRes = await window.vyotiq.marketplaceRefreshCatalog()
        if (!refreshRes.ok) pushToast(refreshRes.error, 'error')
      }
      await reload()
    } finally {
      setCatalogLoading(false)
    }
  }, [reload, settings.marketplace?.registryUrl])

  useEffect(() => {
    void reload()
  }, [reload, settings.marketplace?.registryUrl])

  useEffect(() => {
    void loadProjectRules()
  }, [loadProjectRules])

  useEffect(() => {
    void loadToolCatalog()
  }, [loadToolCatalog])

  useEffect(() => {
    const onCatalogRefreshed = (): void => {
      void reload()
    }
    window.addEventListener('vyotiq:marketplace-catalog-refreshed', onCatalogRefreshed)
    return () => {
      window.removeEventListener('vyotiq:marketplace-catalog-refreshed', onCatalogRefreshed)
    }
  }, [reload])

  useEffect(() => {
    if (!window.vyotiq?.onSkillsChanged) return
    return window.vyotiq.onSkillsChanged(() => {
      void reload()
      void loadProjectRules()
    })
  }, [reload, loadProjectRules])

  useEffect(() => {
    // A server connecting, a sign-in landing or a Force off all end in a
    // catalog push; the status rows move with it.
    if (!window.vyotiq?.onToolsCatalogChanged) return
    return window.vyotiq.onToolsCatalogChanged(() => {
      void loadToolCatalog()
      void loadMcpStatus(false)
    })
  }, [loadToolCatalog, loadMcpStatus])

  useEffect(() => {
    // Poll status only — full disconnect/reconnect is reserved for Reconnect all.
    void loadMcpStatus(false)
  }, [loadMcpStatus, installed.items.length, settings.mcpServers, workspaceOverride])

  const anyConnecting = mcpStatus.some((s) => s.connecting)
  useEffect(() => {
    // Nothing is pushed when a dial finishes without changing the tool list,
    // so a row that says "Connecting…" is looked at again until it is not.
    if (!anyConnecting) {
      connectingPollsRef.current = 0
      return
    }
    if (connectingPollsRef.current >= CONNECTING_POLL_MAX) return
    const timer = window.setTimeout(() => {
      connectingPollsRef.current += 1
      void loadMcpStatus(false)
    }, CONNECTING_POLL_MS)
    return () => window.clearTimeout(timer)
  }, [anyConnecting, mcpStatus, loadMcpStatus])

  const ensureRemoteAck = useCallback(async (): Promise<boolean> => {
    if (settings.marketplace?.remoteInstallAcked) return true
    const res = await window.vyotiq.marketplaceAckRemoteInstall(true)
    if (!res.ok) {
      pushToast(res.error, 'error')
      return false
    }
    if (!res.data.marketplace?.remoteInstallAcked) return false
    await onReloadSettings?.()
    return true
  }, [onReloadSettings, settings.marketplace?.remoteInstallAcked])

  const afterMutation = useCallback(async (): Promise<void> => {
    await reload()
    await onReloadSettings?.()
    await loadMcpStatus(false)
  }, [reload, onReloadSettings, loadMcpStatus])

  const runInstall = useCallback(
    async (
      payload: MarketplaceInstallRequest,
      /** `needsConnect` swaps the success copy for packages that still need auth. */
      opts?: { busyTargetId?: string | null; needsConnect?: boolean }
    ): Promise<MarketplaceInstalledItem | null> => {
      beginBusy(opts?.busyTargetId)
      try {
        if (REMOTE_INSTALL_SOURCES.has(payload.source)) {
          const acked = await ensureRemoteAck()
          if (!acked) return null
        }
        const res = await window.vyotiq.marketplaceInstall(payload)
        if (!res.ok) {
          pushToast(res.error, 'error')
          return null
        }
        const { item, authTokenStored, dependencies } = res.data
        // An interlinked skill can pull siblings in with it. Name them: an
        // install that grew from one package to several should not be silent.
        const dependencyHint =
          dependencies && dependencies.length > 0
            ? ` Also added ${dependencies.join(', ')}, which it hands work to.`
            : ''
        let tokenHint = ''
        if (payload.source === 'remote' && payload.bearerToken?.trim()) {
          tokenHint =
            authTokenStored === false
              ? ' The token could not be stored in OS secure storage — add it again from its Configuration.'
              : ' Token stored in OS secure storage.'
        }
        pushToast(
          opts?.needsConnect
            ? `Added ${item.name} — sign in to connect it.${dependencyHint}`
            : `Added ${item.name}.${tokenHint}${dependencyHint}`,
          authTokenStored === false ? 'error' : 'success'
        )
        // Install IPC already syncs MCP; poll status without disconnecting.
        await afterMutation()
        return item
      } finally {
        endBusy()
      }
    },
    [ensureRemoteAck, afterMutation, beginBusy, endBusy]
  )

  const installFromCatalog = useCallback(
    async (entry: MarketplaceCatalogEntry): Promise<boolean> => {
      if (entry.installable === false) return false
      // The catalog's `auth` is a browse-time mirror and may be absent on a
      // remote entry, so it only pre-seeds the success copy. The installed
      // server's own manifest decides whether to open the connect flow.
      const ok = Boolean(await runInstall(
        entry.bundledPath
          ? { source: 'bundled', target: entry.bundledPath, kind: entry.kind }
          : { source: 'registry', target: entry.id, kind: entry.kind },
        {
          busyTargetId: entry.id,
          needsConnect: entry.kind === 'mcp' && !!entry.auth && entry.auth !== 'none'
        }
      ))
      if (ok && entry.kind === 'mcp' && (await serverNeedsConnect(entry.id, workspacePath))) {
        setConnectWizardId(entry.id)
      }
      return ok
    },
    [workspacePath, runInstall]
  )

  /** The package's own switch, for every workspace that does not override it. */
  const setEnabled = useCallback(
    async (item: MarketplaceInstalledItem, enabled: boolean): Promise<boolean> => {
      beginBusy(item.id)
      try {
        const res = await window.vyotiq.marketplaceSetEnabled(item.id, enabled)
        if (!res.ok) {
          pushToast(res.error, 'error')
          return false
        }
        setInstalled(res.data)
        if (item.kind === 'mcp' || item.kind === 'plugin') {
          await onReloadSettings?.()
          await loadMcpStatus(false)
        }
        return true
      } finally {
        endBusy()
      }
    },
    [loadMcpStatus, onReloadSettings, beginBusy, endBusy]
  )

  /** A server added by hand keeps its switch in settings. */
  const setServerEnabled = useCallback(
    async (serverId: string, enabled: boolean): Promise<boolean> =>
      runUpdate({
        mcpServers: settings.mcpServers.map((s) => (s.id === serverId ? { ...s, enabled } : s))
      }),
    [runUpdate, settings.mcpServers]
  )

  const updateServer = useCallback(
    async (next: McpServer): Promise<boolean> =>
      runUpdate({
        mcpServers: settings.mcpServers.map((s) => (s.id === next.id ? next : s))
      }),
    [runUpdate, settings.mcpServers]
  )

  const removeServer = useCallback(
    async (serverId: string): Promise<boolean> => {
      beginBusy(serverId)
      try {
        // The token lives in OS secure storage, not settings; leaving it would
        // hand it to the next server someone adds under the same id.
        await window.vyotiq.mcpClearAuthToken?.(serverId)
        const ok = await runUpdate({
          mcpServers: settings.mcpServers.filter((s) => s.id !== serverId)
        })
        if (ok) await loadMcpStatus(false)
        return ok
      } finally {
        endBusy()
      }
    },
    [beginBusy, endBusy, runUpdate, settings.mcpServers, loadMcpStatus]
  )

  const uninstall = useCallback(
    async (item: MarketplaceInstalledItem, opts?: { signOutGithub?: boolean }): Promise<boolean> => {
      beginBusy(item.id)
      try {
        const res = await window.vyotiq.marketplaceUninstall(item.id, {
          signOutGithub: opts?.signOutGithub === true
        })
        if (!res.ok) {
          pushToast(res.error, 'error')
          return false
        }
        setInstalled(res.data)
        pushToast(`Removed ${item.name}.`, 'success')
        await onReloadSettings?.()
        await loadMcpStatus(false)
        return true
      } finally {
        endBusy()
      }
    },
    [loadMcpStatus, onReloadSettings, beginBusy, endBusy]
  )

  /**
   * Force on, Force off or follow the global switch (`null`) in the active
   * workspace. Main re-syncs the servers that should be running on the write.
   */
  const setWorkspaceOverride = useCallback(
    async (kind: MarketplaceOverrideKind, id: string, value: boolean | null): Promise<boolean> => {
      if (!workspacePath || !onSetSettingsOverride) return false
      const prev: WorkspaceSettingsOverride = workspaceOverride ?? { useOverride: false }
      const marketplaceOverrides = { ...(prev.marketplaceOverrides ?? {}) }
      const forKind = { ...(marketplaceOverrides[kind] ?? {}) }
      if (value === null) delete forKind[id]
      else forKind[id] = value
      marketplaceOverrides[kind] = forKind
      beginBusy(id)
      try {
        const res = await onSetSettingsOverride(workspacePath, { ...prev, marketplaceOverrides })
        if (!res.ok) {
          pushToast(res.error, 'error')
          return false
        }
        await loadMcpStatus(false)
        return true
      } finally {
        endBusy()
      }
    },
    [workspacePath, onSetSettingsOverride, workspaceOverride, beginBusy, endBusy, loadMcpStatus]
  )

  /**
   * Parse what was pasted. Only a git URL reaches out (it clones), so only it
   * asks for the install acknowledgement first.
   */
  const detectMcp = useCallback(
    async (input: string, opts?: { acknowledge?: boolean }): Promise<Outcome<McpDetectResult>> => {
      if (opts?.acknowledge && !(await ensureRemoteAck())) {
        return { ok: false, error: 'The install acknowledgement was not recorded.' }
      }
      const res = await window.vyotiq.marketplaceDetectMcp({ input: input.trim() })
      return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error }
    },
    [ensureRemoteAck]
  )

  const applyDetectedMcp = useCallback(
    async (payload: McpApplyDetectedRequest): Promise<Outcome<McpApplyDetectedResult>> => {
      beginBusy('marketplace-apply')
      try {
        if (!(await ensureRemoteAck())) {
          return { ok: false, error: 'The install acknowledgement was not recorded.' }
        }
        const res = await window.vyotiq.marketplaceApplyDetectedMcp(payload)
        if (!res.ok) return { ok: false, error: res.error }
        const name = res.data.installResult?.item.name ?? payload.server?.name
        pushToast(name ? `Added ${name}.` : 'Added.', 'success')
        await afterMutation()
        return { ok: true, data: res.data }
      } finally {
        endBusy()
      }
    },
    [ensureRemoteAck, afterMutation, beginBusy, endBusy]
  )

  const scanExternalMcp = useCallback(
    async (source: { paths?: string[]; json?: string }): Promise<Outcome<McpImportExternalResult>> => {
      beginBusy('marketplace-scan')
      try {
        const res = await window.vyotiq.marketplaceScanExternalMcp({
          ...(source.paths?.length ? { paths: source.paths } : {}),
          ...(source.json?.trim() ? { json: source.json } : {})
        })
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error }
      } finally {
        endBusy()
      }
    },
    [beginBusy, endBusy]
  )

  const importExternalMcp = useCallback(
    async (payload: McpImportExternalRequest): Promise<Outcome<McpImportExternalResult>> => {
      beginBusy('marketplace-import')
      try {
        if (!(await ensureRemoteAck())) {
          return { ok: false, error: 'The install acknowledgement was not recorded.' }
        }
        const res = await window.vyotiq.marketplaceImportExternalMcp(payload)
        if (!res.ok) return { ok: false, error: res.error }
        const { applied, skipped, warnings } = res.data
        const warned = warnings.length > 0 ? ` ${warnings.slice(0, 2).join(' ')}` : ''
        pushToast(
          `Imported ${applied} MCP server${applied === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.${warned}`,
          warnings.length > 0 ? 'error' : 'success'
        )
        await afterMutation()
        return { ok: true, data: res.data }
      } finally {
        endBusy()
      }
    },
    [ensureRemoteAck, afterMutation, beginBusy, endBusy]
  )

  return {
    workspacePath,
    catalog,
    catalogLoading,
    installed,
    localSkills,
    projectRules,
    toolCatalog,
    busy,
    busyTargetId,
    formLocked,
    mcpStatusById,
    mcpStatusLoaded,
    hasGoogleMcpClientSecret,
    hasGoogleMcpClient,
    connectWizardId,
    openConnectWizard: setConnectWizardId,
    closeConnectWizard: () => setConnectWizardId(null),
    workspaceOverrides: workspaceOverride?.marketplaceOverrides ?? null,
    canOverrideWorkspace: Boolean(workspacePath && onSetSettingsOverride),
    loadMcpStatus,
    loadProjectRules,
    runUpdate,
    reload,
    refreshCatalog,
    ensureRemoteAck,
    runInstall,
    installFromCatalog,
    setEnabled,
    setServerEnabled,
    updateServer,
    removeServer,
    uninstall,
    setWorkspaceOverride,
    detectMcp,
    applyDetectedMcp,
    scanExternalMcp,
    importExternalMcp
  }
}

export type MarketplaceController = ReturnType<typeof useMarketplaceController>
