import { useEffect, useState } from 'react'
import type { ToolCatalogEntry, ToolCatalogResult } from '@shared/ipc'

const REASON_LABELS: Record<NonNullable<ToolCatalogEntry['reason']>, string> = {
  'server-disabled': 'server disabled',
  'auth-not-allowed': 'auth not allowed for this workspace',
  'denied-by-policy': 'denied by server tool policy',
  'auto-mode-switch-off': 'needs automatic mode switching',
  'code-index-off': 'code index disabled'
}

function ToolRow({ entry }: { entry: ToolCatalogEntry }) {
  return (
    <li className="flex flex-col gap-0.5 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-fg-strong">{entry.name}</span>
        {entry.active ? (
          <span className="shrink-0 text-2xs font-medium text-fg-strong">active</span>
        ) : entry.reason ? (
          <span className="shrink-0 text-2xs font-medium text-tertiary">
            {REASON_LABELS[entry.reason]}
          </span>
        ) : null}
      </div>
      {entry.description ? (
        <p className="m-0 text-xs leading-snug text-secondary [overflow-wrap:break-word]">
          {entry.description}
        </p>
      ) : null}
      <p className="m-0 text-2xs text-tertiary">{entry.modes.join(' · ')}</p>
    </li>
  )
}

/**
 * Live snapshot of the agent tool catalog: built-ins plus every connected MCP
 * server tool, each with its real active state. Pushed updates arrive via
 * `tools-catalog:changed`; a fallback fetch covers renderer reloads.
 */
export function ToolCatalogCard() {
  const [catalog, setCatalog] = useState<ToolCatalogResult | null>(null)

  useEffect(() => {
    let disposed = false
    void window.vyotiq
      ?.toolsCatalogGet?.()
      .then((res) => {
        if (res.ok && !disposed) setCatalog(res.data)
      })
      .catch(() => {})
    const unsubscribe = window.vyotiq?.onToolsCatalogChanged?.((payload) => {
      if (!disposed) setCatalog(payload)
    })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  if (!catalog) return null

  const builtins = catalog.entries.filter((entry) => entry.source === 'builtin')
  const mcpByServer = new Map<string, ToolCatalogEntry[]>()
  for (const entry of catalog.entries) {
    if (entry.source !== 'mcp' || !entry.serverId) continue
    const list = mcpByServer.get(entry.serverId)
    if (list) list.push(entry)
    else mcpByServer.set(entry.serverId, [entry])
  }
  const agentBuilt = catalog.entries.filter((entry) => entry.source === 'agent')
  const activeCount = catalog.entries.filter((entry) => entry.active).length
  const serverMetaById = new Map(catalog.servers.map((s) => [s.id, s]))

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="m-0 text-xs text-secondary">
        {activeCount} of {catalog.entries.length} tools active · code index{' '}
        {catalog.codeIndexEnabled ? 'on' : 'off'} · automatic mode switching{' '}
        {catalog.autoModeSwitch ? 'on' : 'off'}
      </p>

      <div>
        <p className="m-0 mb-1 text-xs font-medium text-fg-strong">
          Built-in tools ({builtins.length})
        </p>
        <ul className="m-0 list-none divide-y divide-border/60 rounded-lg border border-border/60 p-0">
          {builtins.map((entry) => (
            <ToolRow key={entry.name} entry={entry} />
          ))}
        </ul>
      </div>

      {agentBuilt.length > 0 ? (
        <div>
          <p className="m-0 mb-1 text-xs font-medium text-fg-strong">
            Agent-built tools ({agentBuilt.length}){' '}
            <span className="font-normal text-tertiary">
              (written by a run — each call asks you, and asks again whenever the code
              changes)
            </span>
          </p>
          <ul className="m-0 list-none divide-y divide-border/60 rounded-lg border border-border/60 p-0">
            {agentBuilt.map((entry) => (
              <ToolRow key={entry.name} entry={entry} />
            ))}
          </ul>
        </div>
      ) : null}

      {[...mcpByServer.entries()].map(([serverId, entries]) => {
        const server = serverMetaById.get(serverId)
        return (
          <div key={serverId}>
            <p className="m-0 mb-1 text-xs font-medium text-fg-strong">
              {server?.name ?? serverId}{' '}
              <span className="font-normal text-tertiary">
                ({server?.connected ? 'connected' : server?.enabled === false ? 'disabled' : 'not connected'}
                {server?.loading === 'every-step'
                  ? ' · loaded every step'
                  : ' · loaded on demand'}
                )
              </span>
            </p>
            <ul className="m-0 list-none divide-y divide-border/60 rounded-lg border border-border/60 p-0">
              {entries.map((entry) => (
                <ToolRow key={entry.name} entry={entry} />
              ))}
            </ul>
          </div>
        )
      })}

      <p className="m-0 text-xs text-tertiary">
        Built-in tools ship with the app and cannot be removed. Add or remove MCP tools from the
        server cards — enable/disable a server, or edit its allowed/denied tool lists. A server
        loaded on demand is fully available to the agent; its schemas reach a run only once that
        run asks for them, which keeps the context window free. This list updates live; no restart
        needed.
      </p>
    </div>
  )
}
