import { useEffect, useState } from 'react'
import type {
  MarketplaceInstalledItem,
  McpServer,
  PackageContents,
  Settings
} from '@shared/ipc'
import { Button } from '@renderer/lib/ui'
import { McpServerCard } from './McpServerCard'
import {
  mcpStatusClass,
  mcpStatusLabel
} from './mcpStatus'
import { kindLabel } from './marketplaceLabels'
import { WorkspaceEnableControls } from './WorkspaceEnableControls'
import type { MarketplaceController } from './useMarketplaceController'

function nestedPluginMcpServerId(pluginId: string, nestedId: string): string {
  return `plugin-${pluginId}-${nestedId}`.replace(/__/g, '-')
}

function aggregateMcpStatuses(
  statuses: Array<ReturnType<MarketplaceController['mcpStatusById']['get']>>
): ReturnType<MarketplaceController['mcpStatusById']['get']> {
  const defined = statuses.filter((s): s is NonNullable<typeof s> => s != null)
  if (defined.length === 0) return undefined
  const connected = defined.filter((s) => s.connected)
  const enabled = defined.some((s) => s.enabled)
  const toolCount = defined.reduce((n, s) => n + (s.toolCount ?? 0), 0)
  const errors = defined.map((s) => s.error).filter((e): e is string => Boolean(e))
  const hasAuthToken = defined.some((s) => s.hasAuthToken === true)
  return {
    id: defined[0]!.id,
    name: defined[0]!.name,
    enabled,
    connected: connected.length > 0,
    toolCount,
    ...(hasAuthToken ? { hasAuthToken: true } : {}),
    ...(errors[0] ? { error: errors[0] } : {})
  }
}

function InstalledPackageContents({
  itemId,
  onContents
}: {
  itemId: string
  onContents?: (contents: PackageContents | null) => void
}) {
  const [contents, setContents] = useState<PackageContents | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.vyotiq.marketplaceGetContents(itemId)
      if (cancelled) return
      if (!res.ok) {
        setContents(null)
        onContents?.(null)
        return
      }
      setContents(res.data)
      onContents?.(res.data)
    })()
    return () => {
      cancelled = true
    }
  }, [itemId, onContents])

  if (!contents) return null
  const parts: string[] = []
  if (contents.mcp.length) {
    parts.push(`MCP: ${contents.mcp.map((m) => m.name).join(', ')}`)
  }
  if (contents.skills.length) {
    parts.push(`Skills: ${contents.skills.map((s) => s.name).join(', ')}`)
  }
  if (contents.rules.length) {
    parts.push(`Rules: ${contents.rules.map((r) => r.path).join(', ')}`)
  }
  if (parts.length === 0) return null
  return <p className="m-0 mt-1 text-muted">{parts.join(' · ')}</p>
}

type WorkspaceEnableFns = {
  setWorkspaceEnable: (
    kind: 'mcp' | 'skills' | 'plugins',
    id: string,
    enabled: boolean
  ) => Promise<void>
  clearWorkspaceEnable: (kind: 'mcp' | 'skills' | 'plugins', id: string) => Promise<void>
  workspaceEnabledForId: (kind: 'mcp' | 'skills' | 'plugins', id: string) => boolean | undefined
}

function InstalledMarketplaceItem({
  item,
  controller,
  settings,
  linked,
  ws,
  activeWorkspacePath,
  canOverride,
  setWorkspaceEnable,
  clearWorkspaceEnable,
  workspaceEnabledForId
}: {
  item: MarketplaceInstalledItem
  controller: MarketplaceController
  settings: Settings
  linked: McpServer | undefined
  ws: boolean | undefined
  activeWorkspacePath?: string | null
  canOverride: boolean
} & WorkspaceEnableFns) {
  const [pluginContents, setPluginContents] = useState<PackageContents | null>(null)
  const { formLocked, mcpStatusById, runUpdate, setEnabled, uninstall } = controller

  const status = (() => {
    if (item.kind === 'mcp') {
      return linked ? mcpStatusById.get(linked.id) : mcpStatusById.get(item.id)
    }
    if (item.kind === 'plugin') {
      if (!pluginContents?.mcp.length) return undefined
      return aggregateMcpStatuses(
        pluginContents.mcp.map((m) => mcpStatusById.get(nestedPluginMcpServerId(item.id, m.id)))
      )
    }
    return undefined
  })()

  const showMcpStatus =
    item.kind === 'mcp' || (item.kind === 'plugin' && (pluginContents?.mcp.length ?? 0) > 0)

  const overrideKind =
    item.kind === 'mcp' ? 'mcp' : item.kind === 'skill' ? 'skills' : 'plugins'

  return (
    <div className="rounded-md border border-border bg-surface px-2.5 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="m-0 font-medium text-fg">
          {item.name} <span className="text-muted">({kindLabel(item.kind)})</span>
        </p>
        <label className="inline-flex items-center gap-1.5 text-secondary">
          <input
            type="checkbox"
            className="size-3.5 accent-fg"
            checked={item.enabled}
            disabled={formLocked}
            aria-label={`Enable ${item.name}`}
            onChange={(e) => void setEnabled(item, e.target.checked)}
          />
          Global
        </label>
      </div>
      <p className="m-0 mt-1 text-secondary">{item.description || '—'}</p>
      {showMcpStatus && !linked ? (
        <p className={`m-0 mt-1 ${mcpStatusClass(status, { workspaceEnabled: ws })}`}>
          {mcpStatusLabel(status, { workspaceEnabled: ws })}
        </p>
      ) : null}
      {status?.error && !linked ? (
        <p className="m-0 mt-1 text-danger [overflow-wrap:anywhere]">{status.error}</p>
      ) : null}
      <InstalledPackageContents
        itemId={item.id}
        onContents={item.kind === 'plugin' ? setPluginContents : undefined}
      />
      {linked && item.kind === 'mcp' ? (
        <div className="mt-2">
          <McpServerCard
            server={linked}
            status={status}
            disabled={formLocked}
            hideEnable
            hideRemove
            workspaceEnabled={ws}
            googleMcpClientId={settings.googleMcpClientId}
            onUpdate={async (next) => {
              const updated = settings.mcpServers.map((s) => (s.id === linked.id ? next : s))
              return runUpdate({ mcpServers: updated })
            }}
            onRemove={() => undefined}
            onAuthChanged={() => {
              void controller.loadMcpStatus(true)
            }}
            onOpenConnect={() => controller.openConnectWizard(linked.id)}
          />
        </div>
      ) : null}
      {item.kind === 'plugin' && pluginContents && pluginContents.mcp.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2">
          <p className="m-0 text-caption font-medium text-secondary">Package MCP servers</p>
          {pluginContents.mcp.map((nested) => {
            const nestedId = nestedPluginMcpServerId(item.id, nested.id)
            const overlay = settings.mcpServers.find((s) => s.id === nestedId)
            const nestedStatus = mcpStatusById.get(nestedId)
            const nestedWs = workspaceEnabledForId('mcp', nestedId)
            const server: McpServer = overlay ?? {
              id: nestedId,
              name: `${item.name}: ${nested.name}`,
              transport: nested.transport ?? 'stdio',
              command: nested.command,
              url: nested.url,
              enabled: true,
              source: 'marketplace',
              packageId: item.id
            }
            return (
              <div key={nestedId} className="flex flex-col gap-1">
                <McpServerCard
                  server={server}
                  status={nestedStatus}
                  disabled={formLocked}
                  hideEnable
                  hideRemove
                  workspaceEnabled={nestedWs}
                  googleMcpClientId={settings.googleMcpClientId}
                  onUpdate={async (next) => {
                    const others = settings.mcpServers.filter((s) => s.id !== nestedId)
                    return runUpdate({ mcpServers: [...others, next] })
                  }}
                  onRemove={() => undefined}
                  onAuthChanged={() => {
                    void controller.loadMcpStatus(true)
                  }}
                  onOpenConnect={() => controller.openConnectWizard(nestedId)}
                />
                {activeWorkspacePath && canOverride ? (
                  <WorkspaceEnableControls
                    label="This MCP in workspace:"
                    formLocked={formLocked}
                    ws={nestedWs}
                    onForceOn={() => void setWorkspaceEnable('mcp', nestedId, true)}
                    onForceOff={() => void setWorkspaceEnable('mcp', nestedId, false)}
                    onUseGlobal={() => void clearWorkspaceEnable('mcp', nestedId)}
                    className="flex flex-wrap items-center gap-2 px-0.5"
                  />
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
      {activeWorkspacePath && canOverride ? (
        <WorkspaceEnableControls
          formLocked={formLocked}
          ws={ws}
          onForceOn={() => void setWorkspaceEnable(overrideKind, item.id, true)}
          onForceOff={() => void setWorkspaceEnable(overrideKind, item.id, false)}
          onUseGlobal={() => void clearWorkspaceEnable(overrideKind, item.id)}
        />
      ) : null}
      <Button
        variant="danger"
        className="mt-2"
        disabled={formLocked}
        onClick={() => void uninstall(item.id)}
      >
        Uninstall
      </Button>
    </div>
  )
}

export function MarketplaceInstalledList({
  controller,
  settings,
  activeWorkspacePath,
  canOverride,
  setWorkspaceEnable,
  clearWorkspaceEnable,
  workspaceEnabledForId
}: {
  controller: MarketplaceController
  settings: Settings
  activeWorkspacePath?: string | null
  canOverride: boolean
} & WorkspaceEnableFns) {
  const { installed } = controller

  const workspaceEnabled = (item: MarketplaceInstalledItem): boolean | undefined => {
    const kind = item.kind === 'mcp' ? 'mcp' : item.kind === 'skill' ? 'skills' : 'plugins'
    return workspaceEnabledForId(kind, item.id)
  }

  const mcpServerForPackage = (item: MarketplaceInstalledItem) =>
    settings.mcpServers.find(
      (s) => s.source === 'marketplace' && (s.packageId === item.id || s.id === item.id)
    )

  return (
    <div className="flex flex-col gap-2">
      {installed.items.length === 0 ? (
        <p className="m-0 text-xs text-muted">
          Nothing installed yet. Browse the catalog to add MCP servers, skills, or packages.
        </p>
      ) : (
        installed.items.map((item) => (
          <div
            key={item.id}
            data-mcp-server-id={item.kind === 'mcp' ? item.id : undefined}
            tabIndex={-1}
          >
            <InstalledMarketplaceItem
              item={item}
              controller={controller}
              settings={settings}
              linked={item.kind === 'mcp' ? mcpServerForPackage(item) : undefined}
              ws={workspaceEnabled(item)}
              activeWorkspacePath={activeWorkspacePath}
              canOverride={canOverride}
              setWorkspaceEnable={setWorkspaceEnable}
              clearWorkspaceEnable={clearWorkspaceEnable}
              workspaceEnabledForId={workspaceEnabledForId}
            />
          </div>
        ))
      )}
    </div>
  )
}
