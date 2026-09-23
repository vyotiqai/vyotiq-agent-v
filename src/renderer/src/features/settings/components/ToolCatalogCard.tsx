import { useEffect, useState } from 'react'
import type { ToolCatalogEntry, ToolCatalogResult } from '@shared/ipc'
import { Icon } from '@renderer/lib/icons'

const REASON_LABELS: Record<NonNullable<ToolCatalogEntry['reason']>, string> = {
  'server-disabled': 'server disabled',
  'auth-not-allowed': 'auth not allowed for this workspace',
  'denied-by-policy': 'denied by server tool policy',
  'auto-mode-switch-off': 'needs automatic mode switching',
  'code-index-off': 'code index disabled'
}

/** Active is the norm; only the exceptions carry a label, so they stand out. */
function ToolRow({ entry }: { entry: ToolCatalogEntry }) {
  return (
    <li className="flex flex-col gap-0.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-fg">{entry.name}</span>
        {!entry.active && entry.reason ? (
          <span className="shrink-0 text-2xs text-tertiary">{REASON_LABELS[entry.reason]}</span>
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
 * One source of tools, collapsed to a single line until opened. Expanded
 * lists run to dozens of rows each; closed, the card answers "what is
 * connected and how much of it is live" in a line per source.
 */
function ToolGroup({
  title,
  meta,
  note,
  defaultOpen,
  entries
}: {
  title: string
  meta?: string
  /** First line inside the open group — how its tools are gated. */
  note?: string
  defaultOpen?: boolean
  entries: ToolCatalogEntry[]
}) {
  const active = entries.filter((entry) => entry.active).length
  return (
    <details className="group/tools" open={defaultOpen}>
      <summary className="-mx-1.5 flex cursor-pointer list-none items-center gap-2 rounded-md px-1.5 py-1.5 text-xs vy-transition hover:bg-surface-2 focus-visible:vy-focus-ring [&::-webkit-details-marker]:hidden">
        <Icon
          name="chevron"
          size={12}
          className="shrink-0 -rotate-90 text-muted vy-transition group-open/tools:rotate-0"
        />
        <span className="min-w-0 truncate text-fg">{title}</span>
        {meta ? <span className="min-w-0 truncate text-2xs text-muted">{meta}</span> : null}
        <span className="ml-auto shrink-0 text-2xs tabular-nums text-muted">
          {active}/{entries.length} active
        </span>
      </summary>
      {note ? <p className="m-0 pb-1 pl-5 text-2xs text-tertiary">{note}</p> : null}
      <ul className="m-0 list-none divide-y divide-border/40 p-0 pl-5">
        {entries.map((entry) => (
          <ToolRow key={entry.name} entry={entry} />
        ))}
      </ul>
    </details>
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
  const agentBuilt = catalog.entries.filter((entry) => entry.source === 'agent')
  const mcpByServer = new Map<string, ToolCatalogEntry[]>()
  for (const entry of catalog.entries) {
    if (entry.source !== 'mcp' || !entry.serverId) continue
    const list = mcpByServer.get(entry.serverId)
    if (list) list.push(entry)
    else mcpByServer.set(entry.serverId, [entry])
  }
  const activeCount = catalog.entries.filter((entry) => entry.active).length
  const serverMetaById = new Map(catalog.servers.map((s) => [s.id, s]))

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="m-0 pb-1 text-xs text-secondary">
        {activeCount} of {catalog.entries.length} tools active
      </p>
      <ToolGroup title={`Built-in tools (${builtins.length})`} entries={builtins} />
      {/* Open from the start, unlike the long lists around it: there are
          rarely more than a few, and each is code a run wrote, so what it is
          and how it is gated should not sit behind a click. */}
      {agentBuilt.length > 0 ? (
        <ToolGroup
          title={`Agent-built tools (${agentBuilt.length})`}
          note="Written by a run — each call asks you, and asks again whenever the code changes."
          defaultOpen
          entries={agentBuilt}
        />
      ) : null}
      {[...mcpByServer.entries()].map(([serverId, entries]) => {
        const server = serverMetaById.get(serverId)
        const state = server?.connected
          ? 'connected'
          : server?.enabled === false
            ? 'disabled'
            : 'not connected'
        const loading = server?.loading === 'every-step' ? 'loaded every step' : 'loaded on demand'
        return (
          <ToolGroup
            key={serverId}
            title={server?.name ?? serverId}
            meta={`${state} · ${loading}`}
            entries={entries}
          />
        )
      })}
    </div>
  )
}
