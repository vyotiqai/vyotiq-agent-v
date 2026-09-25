import { useEffect, useId, useState } from 'react'
import type { ToolCatalogEntry, ToolCatalogResult } from '@shared/ipc'
import { Icon, type IconName } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'

const REASON_LABELS: Record<NonNullable<ToolCatalogEntry['reason']>, string> = {
  'server-disabled': 'server disabled',
  'auth-not-allowed': 'auth not allowed for this workspace',
  'denied-by-policy': 'denied by server tool policy',
  'auto-mode-switch-off': 'needs automatic mode switching',
  'code-index-off': 'code index disabled'
}

/** Rows an open group lists before "… N more": the built-ins alone run past forty. */
const PREVIEW_ROWS = 8

/**
 * The modes a task can be in. The catalog still reports Plan, which folds
 * into Agent on read, so it is not a mode anyone can pick.
 */
const SHOWN_MODES = ['agent', 'ask'] as const

/**
 * Live snapshot of the agent tool catalog: built-ins plus every connected MCP
 * server tool, each with its real active state. Pushed updates arrive via
 * `tools-catalog:changed`; a fallback fetch covers renderer reloads.
 */
export function useToolCatalog(): ToolCatalogResult | null {
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

  return catalog
}

/** "56 of 82 tools active", for the group label. */
export function toolCatalogSummary(catalog: ToolCatalogResult | null): string | undefined {
  if (!catalog) return undefined
  const active = catalog.entries.filter((entry) => entry.active).length
  return `${active} of ${catalog.entries.length} tools active`
}

function ToolRow({ entry, prefix }: { entry: ToolCatalogEntry; prefix?: string }) {
  // Inside a server's group the `mcp__<server>__` prefix repeats its heading.
  const name = prefix && entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name
  const modes = SHOWN_MODES.filter((mode) => entry.modes.includes(mode)).join(' · ')
  return (
    <li className="flex h-7 items-center gap-3 text-xs">
      <span
        className={cn('w-44 shrink-0 truncate font-mono text-caption', entry.active ? 'text-fg' : 'text-tertiary')}
        title={entry.name}
      >
        {name}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted" title={entry.description || undefined}>
        {entry.description}
      </span>
      {/* Active is the norm; an inactive tool says why in place of its modes. */}
      <span className="shrink-0 text-tertiary">
        {!entry.active && entry.reason ? REASON_LABELS[entry.reason] : modes}
      </span>
    </li>
  )
}

/**
 * One source of tools as a line — what it is, what state it is in, how much
 * of it is live — that opens into its tools.
 */
function ToolGroup({
  title,
  icon,
  note,
  warn = false,
  defaultOpen = false,
  prefix,
  entries
}: {
  title: string
  icon: IconName
  note?: string
  /** The note is something to act on (a server that should be up and is not). */
  warn?: boolean
  defaultOpen?: boolean
  prefix?: string
  entries: ToolCatalogEntry[]
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [all, setAll] = useState(false)
  const listId = useId()
  const active = entries.filter((entry) => entry.active).length
  const shown = all ? entries : entries.slice(0, PREVIEW_ROWS)
  const hidden = entries.length - shown.length
  const expandable = entries.length > 0

  const line = (
    <>
      {expandable ? (
        <Icon name={open ? 'chevron' : 'chevronRight'} size={11} className="shrink-0 text-tertiary" />
      ) : (
        <span className="w-[11px] shrink-0" aria-hidden />
      )}
      <Icon name={icon} size={14} className="shrink-0 text-muted" />
      <span className="shrink-0 text-sm text-fg">{title}</span>
      {note ? (
        <span className={cn('min-w-0 truncate text-xs', warn ? 'text-warning' : 'text-tertiary')} title={note}>
          {note}
        </span>
      ) : null}
      <span className="flex-1" />
      {expandable ? (
        <span className="shrink-0 font-mono text-caption text-tertiary tnum">
          {active} of {entries.length} active
        </span>
      ) : null}
    </>
  )

  return (
    <div data-tool-group={title}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          className="flex h-10 w-full min-w-0 items-center gap-2.5 rounded-sm text-left focus-visible:vy-focus-ring"
          onClick={() => setOpen((value) => !value)}
        >
          {line}
        </button>
      ) : (
        <div className="flex h-10 min-w-0 items-center gap-2.5">{line}</div>
      )}
      {open && expandable ? (
        <ul id={listId} className="m-0 list-none p-0 pb-2 pl-7">
          {shown.map((entry) => (
            <ToolRow key={entry.name} entry={entry} prefix={prefix} />
          ))}
          {hidden > 0 ? (
            <li>
              <button
                type="button"
                className="flex h-7 items-center rounded-sm text-xs text-tertiary vy-transition hover:text-fg focus-visible:vy-focus-ring"
                onClick={() => setAll(true)}
              >
                … {hidden} more
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * The catalog by source: built-ins, what runs wrote, then each MCP server —
 * including one that is configured but not connected, which lists no tools
 * at all and would otherwise vanish from the page.
 */
export function ToolCatalog({ catalog }: { catalog: ToolCatalogResult }) {
  const builtins = catalog.entries.filter((entry) => entry.source === 'builtin')
  const agentBuilt = catalog.entries.filter((entry) => entry.source === 'agent')
  const mcpByServer = new Map<string, ToolCatalogEntry[]>()
  for (const entry of catalog.entries) {
    if (entry.source !== 'mcp' || !entry.serverId) continue
    const list = mcpByServer.get(entry.serverId)
    if (list) list.push(entry)
    else mcpByServer.set(entry.serverId, [entry])
  }
  const knownIds = new Set(catalog.servers.map((server) => server.id))
  const servers = [
    ...catalog.servers,
    // A tool whose server left the list between snapshots still shows under its id.
    ...[...mcpByServer.keys()]
      .filter((id) => !knownIds.has(id))
      .map((id) => ({ id, name: id, enabled: true, connected: true, loading: 'on-demand' as const }))
  ]

  return (
    <div className="divide-y divide-border border-y border-border">
      <ToolGroup title="Built-in tools" icon="tool" defaultOpen entries={builtins} />
      {/* Open from the start: there are rarely more than a few, and each is
          code a run wrote, so what it is should not sit behind a click. */}
      {agentBuilt.length > 0 ? (
        <ToolGroup
          title="Agent-built tools"
          icon="skill"
          note="Written by a run — each call asks you, and asks again whenever the code changes"
          defaultOpen
          entries={agentBuilt}
        />
      ) : null}
      {servers.map((server) => {
        const entries = mcpByServer.get(server.id) ?? []
        const note = !server.enabled
          ? 'Disabled'
          : server.connected
            ? `Connected · ${server.loading === 'every-step' ? 'loaded every step' : 'loaded on demand'}`
            : 'Not connected'
        return (
          <ToolGroup
            key={server.id}
            title={server.name}
            icon="mcp"
            note={note}
            warn={server.enabled && !server.connected}
            prefix={`mcp__${server.id}__`}
            entries={entries}
          />
        )
      })}
    </div>
  )
}
