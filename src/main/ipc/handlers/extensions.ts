import { ipcMain, BrowserWindow, shell, dialog } from 'electron'
import { IPC } from '../../../shared/channels'
import { isGithubMcpId, isGoogleMcpId } from '../../../shared/mcpApps'
import { notifyToolCatalogChanged } from '../../agent/toolsCatalog'
import { deleteAgentTool, readAgentToolSource } from '../../agent/agentTools/loader'
import { searchMcpRegistry } from '../../marketplace/mcpRegistry'
import { checkPackageUpdates } from '../../marketplace/updateCheck'
import {
  decideWorkspaceHooks,
  ensureHooksFile,
  forgetWorkspaceHooksDecision,
  hooksOverview,
  userHooksPath,
  workspaceHooksPath
} from '../../agent/hooks'
import { resolveAgentToolsDir } from '../../agent/agentTools/paths'
import {
  AgentToolNameRequestSchema,
  HooksDecideRequestSchema,
  McpRegistrySearchRequestSchema,
  HooksForgetRequestSchema,
  HooksOpenFileRequestSchema,
  HooksOverviewRequestSchema,
  MarketplaceBrowseRequestSchema,
  MarketplaceGetContentsRequestSchema,
  MarketplaceInstallRequestSchema,
  MarketplaceRemoteInstallAckRequestSchema,
  MarketplaceSetEnabledRequestSchema,
  MarketplaceUninstallRequestSchema,
  McpDetectRequestSchema,
  McpClearAuthTokenRequestSchema,
  McpClearGoogleClientSecretRequestSchema,
  McpClearOAuthClientSecretRequestSchema,
  McpRefreshRequestSchema,
  McpSetAuthTokenRequestSchema,
  McpSetGoogleClientSecretRequestSchema,
  McpSetOAuthClientSecretRequestSchema,
  McpPickBinaryRequestSchema,
  McpStartOAuthRequestSchema,
  McpStatusRequestSchema,
  McpApplyDetectedRequestSchema,
  McpImportExternalRequestSchema,
  McpScanExternalRequestSchema,
  ok,
  fail,
  type IpcResult,
  type McpStatusResult
} from '../../../shared/ipc'
import { formatError } from '../../../shared/errors'
import { logger } from '../../../shared/logger'
import {
  getSettings,
  setSettings,
  setMarketplaceRemoteInstallAcked,
  redactSettingsForIpc,
  enqueueSettingsMutation
} from '@main/settings/settings'
import {
  syncMcpServers,
  getMcpServerStatus,
  mcpStatusExtras,
  refreshMcpServers,
  retryFailedMcpServers,
  startMcpOAuth
} from '@main/agent/mcp'
import { isExecutableMcpBinary } from '@main/agent/mcp/binaries'
import { headersWithoutAuthorization } from '../../../shared/utils/mcpAuth'
import {
  browseCatalog,
  refreshRemoteCatalog,
  readMarketplaceIndex,
  installMarketplacePackage,
  removeInstalledItem,
  setInstalledEnabled,
  syncMarketplaceMcpIntoSettings,
  resolveEffectiveMcpServers,
  resolveMcpServersForSessionMap,
  getPackageContents,
  detectMcpInput,
  applyDetectedManualMcp,
  scanExternalMcpConfigs,
  importExternalMcpServers,
  invalidateMcpResolveCache
} from '@main/marketplace'
import { gitRemoteHead, npmLatestVersion, registryCatalogVersions } from '@main/marketplace/install'
import {
  setMcpAuthToken,
  clearMcpAuthToken,
  clearMcpOAuthState,
  setMcpOAuthClientSecret,
  clearMcpOAuthClientSecret,
  setGoogleMcpClientSecret,
  clearGoogleMcpClientSecret,
  enqueueSecretsMutation
} from '@main/settings/secrets'
import { getWorkspaces, findWorkspaceSettingsOverride } from '@main/workspace/workspaces'
import { linkNativeGithubFromMcpToken, logoutGithubAuth } from '@main/git/githubAuth'
import { failExpected, failFrom, isOpenWorkspace, senderOk } from '../ipcShared'

/** MCP servers, marketplace packages, hooks, agent-built tools and the MCP Registry. Registered once by registerIpc. */
export function registerExtensionsIpc(): void {
  ipcMain.handle(IPC.mcpStatus, async (event, raw): Promise<IpcResult<McpStatusResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpStatusRequestSchema.parse(raw ?? {})
      const workspaces = getWorkspaces()
      const requestedPath =
        typeof req.workspacePath === 'string' ? req.workspacePath.trim() || null : undefined
      if (requestedPath && !isOpenWorkspace(requestedPath)) {
        return fail('Workspace is not open')
      }
      const workspacePath = requestedPath !== undefined ? requestedPath : workspaces.activePath
      const overrides = workspacePath
        ? findWorkspaceSettingsOverride(workspaces, workspacePath)?.marketplaceOverrides ?? null
        : null
      const servers = resolveEffectiveMcpServers(overrides)
      return ok({ servers: getMcpServerStatus(servers, workspacePath), ...mcpStatusExtras() })
    } catch (err) {
      return failFrom(err, IPC.mcpStatus)
    }
  })

  ipcMain.handle(IPC.mcpRefresh, async (event, raw): Promise<IpcResult<McpStatusResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpRefreshRequestSchema.parse(raw ?? {})
      const workspaces = getWorkspaces()
      const requestedPath =
        typeof req.workspacePath === 'string' ? req.workspacePath.trim() || null : undefined
      if (requestedPath && !isOpenWorkspace(requestedPath)) {
        return fail('Workspace is not open')
      }
      const workspacePath = requestedPath !== undefined ? requestedPath : workspaces.activePath
      const overrides = workspacePath
        ? findWorkspaceSettingsOverride(workspaces, workspacePath)?.marketplaceOverrides ?? null
        : null
      if (req.failedOnly) await retryFailedMcpServers(resolveMcpServersForSessionMap())
      else await refreshMcpServers(resolveMcpServersForSessionMap())
      notifyToolCatalogChanged()
      return ok({
        servers: getMcpServerStatus(resolveEffectiveMcpServers(overrides), workspacePath),
        ...mcpStatusExtras()
      })
    } catch (err) {
      return failFrom(err, IPC.mcpRefresh)
    }
  })

  ipcMain.handle(IPC.marketplaceCheckUpdates, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const items = readMarketplaceIndex().items
      let registryVersion: ((id: string) => Promise<string | null>) | null = null
      return ok(
        await checkPackageUpdates(items, {
          npmLatest: npmLatestVersion,
          gitHead: gitRemoteHead,
          registryVersion: async (id) => {
            registryVersion ??= await registryCatalogVersions()
            return registryVersion(id)
          }
        })
      )
    } catch (err) {
      return failFrom(err, IPC.marketplaceCheckUpdates)
    }
  })

  ipcMain.handle(IPC.mcpRegistrySearch, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpRegistrySearchRequestSchema.parse(raw)
      try {
        return ok(await searchMcpRegistry(req.query))
      } catch (err) {
        return failExpected(`Could not reach the MCP Registry: ${formatError(err)}`, IPC.mcpRegistrySearch)
      }
    } catch (err) {
      return failFrom(err, IPC.mcpRegistrySearch)
    }
  })

  ipcMain.handle(IPC.hooksOverview, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = HooksOverviewRequestSchema.parse(raw ?? {})
      const workspace = req.workspacePath && isOpenWorkspace(req.workspacePath) ? req.workspacePath : null
      return ok(hooksOverview(workspace))
    } catch (err) {
      return failFrom(err, IPC.hooksOverview)
    }
  })

  ipcMain.handle(IPC.hooksDecide, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = HooksDecideRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      if (req.decision === 'forget') return ok(forgetWorkspaceHooksDecision(req.workspacePath))
      const done = decideWorkspaceHooks(req.workspacePath, req.decision)
      return done ? ok(true) : failExpected('This workspace has no usable hooks file.', IPC.hooksDecide)
    } catch (err) {
      return failFrom(err, IPC.hooksDecide)
    }
  })

  ipcMain.handle(IPC.hooksForget, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = HooksForgetRequestSchema.parse(raw)
      return ok(forgetWorkspaceHooksDecision(req.workspace))
    } catch (err) {
      return failFrom(err, IPC.hooksForget)
    }
  })

  ipcMain.handle(IPC.hooksOpenFile, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = HooksOpenFileRequestSchema.parse(raw)
      let path: string
      if (req.scope === 'user') path = userHooksPath()
      else {
        if (!req.workspacePath || !isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
        path = workspaceHooksPath(req.workspacePath)
      }
      ensureHooksFile(path)
      const error = await shell.openPath(path)
      return error ? failExpected(error, IPC.hooksOpenFile) : ok(path)
    } catch (err) {
      return failFrom(err, IPC.hooksOpenFile)
    }
  })

  ipcMain.handle(IPC.agentToolSource, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = AgentToolNameRequestSchema.parse(raw)
      const found = await readAgentToolSource(await resolveAgentToolsDir(), req.name)
      return found ? ok(found) : failExpected('That tool is gone.', IPC.agentToolSource)
    } catch (err) {
      return failFrom(err, IPC.agentToolSource)
    }
  })

  ipcMain.handle(IPC.agentToolDelete, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = AgentToolNameRequestSchema.parse(raw)
      const done = await deleteAgentTool(await resolveAgentToolsDir(), req.name, (path) => shell.trashItem(path))
      if (!done) return failExpected('That tool is gone.', IPC.agentToolDelete)
      notifyToolCatalogChanged()
      return ok(done)
    } catch (err) {
      return failFrom(err, IPC.agentToolDelete)
    }
  })

  ipcMain.handle(IPC.mcpSetAuthToken, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { serverId, token } = McpSetAuthTokenRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => setMcpAuthToken(serverId, token))
      await enqueueSettingsMutation(() => {
        invalidateMcpResolveCache()
        const settings = getSettings()
        const nextServers = (settings.mcpServers ?? []).map((s) =>
          s.id === serverId
            ? { ...s, headers: headersWithoutAuthorization(s.headers) }
            : s
        )
        setSettings({ mcpServers: nextServers })
      })
      await syncMcpServers(resolveMcpServersForSessionMap())
      notifyToolCatalogChanged()
      if (isGithubMcpId(serverId)) {
        try {
          await linkNativeGithubFromMcpToken(token)
        } catch (err) {
          logger.warn('Could not link native GitHub after MCP PAT', {
            scope: 'mcp',
            serverId,
            err
          })
        }
      }
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpSetAuthToken)
    }
  })

  ipcMain.handle(IPC.mcpClearAuthToken, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { serverId } = McpClearAuthTokenRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => {
        clearMcpAuthToken(serverId)
        clearMcpOAuthState(serverId)
      })
      await enqueueSettingsMutation(() => {
        invalidateMcpResolveCache()
        const settings = getSettings()
        const nextServers = (settings.mcpServers ?? []).map((s) =>
          s.id === serverId
            ? { ...s, headers: headersWithoutAuthorization(s.headers) }
            : s
        )
        setSettings({ mcpServers: nextServers })
      })
      await syncMcpServers(resolveMcpServersForSessionMap())
      notifyToolCatalogChanged()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpClearAuthToken)
    }
  })

  ipcMain.handle(IPC.mcpSetOAuthClientSecret, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { serverId, secret } = McpSetOAuthClientSecretRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => {
        setMcpOAuthClientSecret(serverId, secret)
        clearMcpOAuthState(serverId)
      })
      invalidateMcpResolveCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpSetOAuthClientSecret)
    }
  })

  ipcMain.handle(IPC.mcpClearOAuthClientSecret, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { serverId } = McpClearOAuthClientSecretRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => {
        clearMcpOAuthClientSecret(serverId)
        clearMcpOAuthState(serverId)
      })
      invalidateMcpResolveCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpClearOAuthClientSecret)
    }
  })

  ipcMain.handle(IPC.mcpSetGoogleClientSecret, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { secret } = McpSetGoogleClientSecretRequestSchema.parse(raw)
      await enqueueSecretsMutation(() => {
        setGoogleMcpClientSecret(secret)
        const settings = getSettings()
        for (const server of settings.mcpServers ?? []) {
          if (isGoogleMcpId(server.id)) clearMcpOAuthState(server.id)
        }
      })
      invalidateMcpResolveCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpSetGoogleClientSecret)
    }
  })

  ipcMain.handle(IPC.mcpClearGoogleClientSecret, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      McpClearGoogleClientSecretRequestSchema.parse(raw ?? {})
      await enqueueSecretsMutation(() => {
        clearGoogleMcpClientSecret()
        const settings = getSettings()
        for (const server of settings.mcpServers ?? []) {
          if (isGoogleMcpId(server.id)) clearMcpOAuthState(server.id)
        }
      })
      invalidateMcpResolveCache()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.mcpClearGoogleClientSecret)
    }
  })

  ipcMain.handle(IPC.mcpStartOAuth, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const parsed = McpStartOAuthRequestSchema.parse(raw)
      await startMcpOAuth(parsed.serverId, {
        authScope: parsed.authScope,
        workspacePath: parsed.workspacePath,
        googleAccess: parsed.googleAccess
      })
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      notifyToolCatalogChanged()
      return ok({
        servers: getMcpServerStatus(resolveEffectiveMcpServers()),
        ...mcpStatusExtras()
      })
    } catch (err) {
      return failFrom(err, IPC.mcpStartOAuth)
    }
  })

  ipcMain.handle(IPC.mcpPickBinary, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { binary } = McpPickBinaryRequestSchema.parse(raw)
      const win = BrowserWindow.fromWebContents(event.sender)
      // Windows hides extensionless files behind a filter, and the default
      // executable extensions differ per platform.
      const options: Electron.OpenDialogOptions = {
        title: `Locate ${binary}`,
        properties: ['openFile'],
        filters:
          process.platform === 'win32'
            ? [
                { name: 'Executables', extensions: ['exe', 'cmd', 'bat', 'com'] },
                { name: 'All', extensions: ['*'] }
              ]
            : [{ name: 'All', extensions: ['*'] }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      const picked = result.canceled ? undefined : result.filePaths[0]
      if (!picked) return ok({ path: null })
      // Reject a directory or a non-executable up front: persisting it would
      // leave the server reporting the same missing binary with no explanation.
      if (!isExecutableMcpBinary(picked)) {
        return fail('That file is not an executable. Pick the program itself.')
      }
      return ok({ path: picked })
    } catch (err) {
      return failFrom(err, IPC.mcpPickBinary)
    }
  })

  ipcMain.handle(IPC.marketplaceListInstalled, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      return ok(readMarketplaceIndex())
    } catch (err) {
      return failFrom(err, IPC.marketplaceListInstalled)
    }
  })

  ipcMain.handle(IPC.marketplaceBrowse, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = MarketplaceBrowseRequestSchema.parse(raw ?? {})
      const packages = await browseCatalog(req)
      return ok({ packages })
    } catch (err) {
      return failFrom(err, IPC.marketplaceBrowse)
    }
  })

  ipcMain.handle(IPC.marketplaceRefreshCatalog, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const remote = await refreshRemoteCatalog()
      const packages = await browseCatalog()
      return ok({ packages, remoteCount: remote.packages.length })
    } catch (err) {
      return failFrom(err, IPC.marketplaceRefreshCatalog)
    }
  })

  ipcMain.handle(IPC.marketplaceInstall, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = MarketplaceInstallRequestSchema.parse(raw)
      const result = await installMarketplacePackage(req)
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      notifyToolCatalogChanged()
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.marketplaceInstall)
    }
  })

  ipcMain.handle(IPC.marketplaceDetectMcp, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpDetectRequestSchema.parse(raw)
      const result = await detectMcpInput(req)
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.marketplaceDetectMcp)
    }
  })

  ipcMain.handle(IPC.marketplaceApplyDetectedMcp, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpApplyDetectedRequestSchema.parse(raw)
      if (req.install) {
        const result = await installMarketplacePackage(req.install)
        invalidateMcpResolveCache()
        await syncMcpServers(resolveMcpServersForSessionMap())
        notifyToolCatalogChanged()
        return ok({
          applied: 'marketplace' as const,
          serverId: result.item.id,
          installResult: result
        })
      }
      const applied = applyDetectedManualMcp(req)
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      notifyToolCatalogChanged()
      return ok(applied)
    } catch (err) {
      return failFrom(err, IPC.marketplaceApplyDetectedMcp)
    }
  })

  ipcMain.handle(IPC.marketplaceScanExternalMcp, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpScanExternalRequestSchema.parse(raw ?? {})
      return ok(scanExternalMcpConfigs(req))
    } catch (err) {
      return failFrom(err, IPC.marketplaceScanExternalMcp)
    }
  })

  ipcMain.handle(IPC.marketplaceImportExternalMcp, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = McpImportExternalRequestSchema.parse(raw)
      const result = await importExternalMcpServers(req)
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      notifyToolCatalogChanged()
      return ok(result)
    } catch (err) {
      return failFrom(err, IPC.marketplaceImportExternalMcp)
    }
  })

  ipcMain.handle(IPC.marketplaceUninstall, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { id, signOutGithub } = MarketplaceUninstallRequestSchema.parse(raw)
      const index = removeInstalledItem(id)
      await syncMarketplaceMcpIntoSettings()
      invalidateMcpResolveCache()
      await syncMcpServers(resolveMcpServersForSessionMap())
      notifyToolCatalogChanged()
      if (signOutGithub && isGithubMcpId(id)) {
        try {
          await logoutGithubAuth()
        } catch (err) {
          logger.warn('GitHub logout after MCP uninstall failed', { scope: 'marketplace', id, err })
        }
      }
      return ok(index)
    } catch (err) {
      return failFrom(err, IPC.marketplaceUninstall)
    }
  })

  ipcMain.handle(IPC.marketplaceSetEnabled, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const { id, enabled } = MarketplaceSetEnabledRequestSchema.parse(raw)
      const index = setInstalledEnabled(id, enabled)
      invalidateMcpResolveCache()
      const item = index.items.find((i) => i.id === id)
      if (item?.kind === 'mcp' || item?.kind === 'plugin') {
        // Plugins too: toggling one changes whether its nested MCP servers
        // belong in settings.
        await syncMarketplaceMcpIntoSettings()
        await syncMcpServers(resolveMcpServersForSessionMap())
        notifyToolCatalogChanged()
      }
      return ok(index)
    } catch (err) {
      return failFrom(err, IPC.marketplaceSetEnabled)
    }
  })

  ipcMain.handle(IPC.marketplacePickLocal, async (event) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Add marketplace package',
        properties: ['openFile', 'openDirectory'],
        filters: [
          { name: 'Packages', extensions: ['zip', 'tgz', 'json', 'md'] },
          { name: 'All', extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return ok(null)
      return ok(result.filePaths[0])
    } catch (err) {
      return failFrom(err, IPC.marketplacePickLocal)
    }
  })

  ipcMain.handle(IPC.marketplaceGetContents, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = MarketplaceGetContentsRequestSchema.parse(raw)
      const contents = getPackageContents(req.id)
      if (!contents) return fail('Package not found')
      return ok(contents)
    } catch (err) {
      return failFrom(err, IPC.marketplaceGetContents)
    }
  })

  ipcMain.handle(IPC.marketplaceAckRemoteInstall, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = MarketplaceRemoteInstallAckRequestSchema.parse(raw ?? { acked: true })
      if (req.acked) {
        const win = BrowserWindow.fromWebContents(event.sender)
        const message =
          'Marketplace packages (remote catalogs, git/npm/zip, local path folders) and MCP endpoints are unsigned. Install only from sources you trust.'
        const result = win
          ? await dialog.showMessageBox(win, {
              type: 'warning',
              buttons: ['Cancel', 'Continue'],
              defaultId: 1,
              cancelId: 0,
              title: 'Acknowledge marketplace risk',
              message
            })
          : await dialog.showMessageBox({
              type: 'warning',
              buttons: ['Cancel', 'Continue'],
              defaultId: 1,
              cancelId: 0,
              title: 'Acknowledge marketplace risk',
              message
            })
        if (result.response !== 1) {
          return ok(redactSettingsForIpc(getSettings()))
        }
      }
      const next = await enqueueSettingsMutation(() =>
        setMarketplaceRemoteInstallAcked(req.acked)
      )
      return ok(redactSettingsForIpc(next))
    } catch (err) {
      return failFrom(err, IPC.marketplaceAckRemoteInstall)
    }
  })
}
