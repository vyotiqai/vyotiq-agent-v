import { useEffect, useState } from 'react'
import type { McpServer, Settings } from '@shared/ipc'
import { Button } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { McpServerCard } from './McpServerCard'
import { MarketplaceAddPanel } from './MarketplaceAddPanel'
import { WorkspaceEnableControls } from './WorkspaceEnableControls'
import type { MarketplaceController } from './useMarketplaceController'

const MCP_DOCS_URL = 'https://modelcontextprotocol.io/'

type WorkspaceEnableFns = {
  setWorkspaceEnable: (
    kind: 'mcp' | 'skills' | 'plugins',
    id: string,
    enabled: boolean
  ) => Promise<void>
  clearWorkspaceEnable: (kind: 'mcp' | 'skills' | 'plugins', id: string) => Promise<void>
  workspaceEnabledForId: (kind: 'mcp' | 'skills' | 'plugins', id: string) => boolean | undefined
}

export function MarketplaceMcpPane({
  controller,
  settings,
  activeWorkspacePath,
  canOverride,
  setWorkspaceEnable,
  clearWorkspaceEnable,
  workspaceEnabledForId,
  openAdd,
  onOpenAddConsumed,
  focusServerId
}: {
  controller: MarketplaceController
  settings: Settings
  activeWorkspacePath?: string | null
  canOverride: boolean
  openAdd?: boolean
  onOpenAddConsumed?: () => void
  focusServerId?: string | null
} & WorkspaceEnableFns) {
  const { formLocked, mcpStatusById, mcpStatusLoading, loadMcpStatus, runUpdate, setFeedback } =
    controller
  const [adding, setAdding] = useState(false)
  const servers = settings.mcpServers
  const hasServers = servers.length > 0

  useEffect(() => {
    if (!openAdd) return
    setAdding(true)
    onOpenAddConsumed?.()
  }, [openAdd, onOpenAddConsumed])

  useEffect(() => {
    if (!focusServerId) return
    setAdding(false)
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-mcp-server-id="${CSS.escape(focusServerId)}"]`
      )
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      el?.focus?.()
    }, 50)
    return () => window.clearTimeout(t)
  }, [focusServerId])

  const openDocs = async (): Promise<void> => {
    const res = await window.vyotiq.shellOpenExternal(MCP_DOCS_URL)
    if (!res.ok) setFeedback({ kind: 'error', text: res.error })
  }

  const toolbar = (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <Button
        variant="subtle"
        disabled={formLocked || mcpStatusLoading}
        onClick={() => void loadMcpStatus(true)}
      >
        {mcpStatusLoading ? 'Refreshing…' : 'Refresh MCP connections'}
      </Button>
      <Button variant="subtle" disabled={formLocked} onClick={() => void openDocs()}>
        Documentation
      </Button>
      <Button
        variant="subtle"
        disabled={formLocked}
        onClick={() => setAdding((v) => !v)}
        aria-pressed={adding}
      >
        <Icon name="plus" size={14} />
        New
      </Button>
    </div>
  )

  if (adding) {
    return (
      <div className="flex flex-col gap-3">
        {toolbar}
        <MarketplaceAddPanel controller={controller} onInstalled={() => setAdding(false)} />
      </div>
    )
  }

  if (!hasServers) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-md border border-border bg-surface px-4 py-5">
        <h2 className="m-0 text-sm font-medium text-fg">Connect External Tools with MCP</h2>
        <p className="m-0 max-w-xl text-xs text-secondary">
          Connect Linear, GitHub, and other tools so the agent can call them during a run.
          Servers you add here sync immediately — no restart.
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button disabled={formLocked} onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} />
            New
          </Button>
          <Button variant="subtle" disabled={formLocked} onClick={() => void openDocs()}>
            Documentation
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {toolbar}
      {servers.map((server) => (
        <McpServerRow
          key={server.id}
          server={server}
          controller={controller}
          settings={settings}
          ws={workspaceEnabledForId('mcp', server.id)}
          activeWorkspacePath={activeWorkspacePath}
          canOverride={canOverride}
          setWorkspaceEnable={setWorkspaceEnable}
          clearWorkspaceEnable={clearWorkspaceEnable}
          formLocked={formLocked}
          runUpdate={runUpdate}
          status={mcpStatusById.get(server.id)}
        />
      ))}
    </div>
  )
}

function McpServerRow({
  server,
  controller,
  settings,
  ws,
  activeWorkspacePath,
  canOverride,
  setWorkspaceEnable,
  clearWorkspaceEnable,
  formLocked,
  runUpdate,
  status
}: {
  server: McpServer
  controller: MarketplaceController
  settings: Settings
  ws: boolean | undefined
  activeWorkspacePath?: string | null
  canOverride: boolean
  setWorkspaceEnable: WorkspaceEnableFns['setWorkspaceEnable']
  clearWorkspaceEnable: WorkspaceEnableFns['clearWorkspaceEnable']
  formLocked: boolean
  runUpdate: MarketplaceController['runUpdate']
  status: ReturnType<MarketplaceController['mcpStatusById']['get']>
}) {
  const marketplace = server.source === 'marketplace'
  return (
    <div data-mcp-server-id={server.id} tabIndex={-1}>
      <McpServerCard
        server={server}
        status={status}
        disabled={formLocked}
        hideEnable={marketplace}
        hideRemove={marketplace}
        workspaceEnabled={ws}
        googleMcpClientId={settings.googleMcpClientId}
        onUpdate={async (next) => {
          const updated = settings.mcpServers.map((s) => (s.id === server.id ? next : s))
          return runUpdate({ mcpServers: updated })
        }}
        onRemove={() => {
          void (async () => {
            await window.vyotiq.mcpClearAuthToken?.(server.id)
            await runUpdate({
              mcpServers: settings.mcpServers.filter((s) => s.id !== server.id)
            })
          })()
        }}
        onAuthChanged={() => {
          void controller.loadMcpStatus(true)
        }}
        onOpenConnect={() => controller.openConnectWizard(server.id)}
      />
      {activeWorkspacePath && canOverride ? (
        <WorkspaceEnableControls
          formLocked={formLocked}
          ws={ws}
          onForceOn={() => void setWorkspaceEnable('mcp', server.id, true)}
          onForceOff={() => void setWorkspaceEnable('mcp', server.id, false)}
          onUseGlobal={() => void clearWorkspaceEnable('mcp', server.id)}
          className="mt-2 flex flex-wrap items-center gap-2 px-0.5"
        />
      ) : null}
    </div>
  )
}
