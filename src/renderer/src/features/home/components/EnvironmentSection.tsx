import { Icon, type IconName } from '@renderer/lib/icons'
import { Button } from '@renderer/lib/ui'
import type { McpHealthIssue } from '../useMcpHealth'
import { HomeCard, HomeSection } from './HomeSection'

export type ProviderIssue = {
  /** Display label of the provider the next run would use. */
  label: string
}

type EnvironmentRow = {
  id: string
  icon: IconName
  title: string
  detail: string
  action?: { label: string; onClick: () => void }
}

/**
 * Renders only when something is actually wrong: a provider with no API key,
 * or an enabled MCP server that is not connected. A healthy environment shows
 * nothing at all rather than a row of green ticks. Each row routes to the
 * surface that can fix it — providers to Settings, servers to their
 * Marketplace entry.
 */
export function EnvironmentSection({
  providerIssue,
  mcpIssues,
  onOpenProviderSettings,
  onOpenMcpServer
}: {
  providerIssue: ProviderIssue | null
  mcpIssues: readonly McpHealthIssue[]
  onOpenProviderSettings?: () => void
  onOpenMcpServer?: (serverId: string) => void
}) {
  const rows: EnvironmentRow[] = []
  if (providerIssue) {
    rows.push({
      id: 'provider',
      icon: 'cpu',
      title: `${providerIssue.label} has no API key`,
      detail: 'Runs cannot start until a key is saved for this provider.',
      ...(onOpenProviderSettings
        ? { action: { label: 'Add key', onClick: onOpenProviderSettings } }
        : {})
    })
  }
  for (const server of mcpIssues) {
    rows.push({
      id: `mcp:${server.id}`,
      icon: 'plug',
      title: `${server.name} is not connected`,
      detail: server.error ?? 'The server is enabled but reported no connection.',
      ...(onOpenMcpServer
        ? { action: { label: 'Manage', onClick: () => onOpenMcpServer(server.id) } }
        : {})
    })
  }

  if (rows.length === 0) return null

  return (
    <HomeSection id="home-environment-heading" title="Environment" count={rows.length}>
      <HomeCard role="list">
        {rows.map((row) => (
          <div
            key={row.id}
            role="listitem"
            className="grid min-w-0 gap-2 px-3 py-2.5 @md:grid-cols-[minmax(0,1fr)_auto] @md:items-center"
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <span
                className="mt-px inline-flex size-4 shrink-0 items-center justify-center text-warning"
                aria-hidden="true"
              >
                <Icon name={row.icon} size={13} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-sm text-fg" title={row.title}>
                  {row.title}
                </p>
                <p className="m-0 mt-0.5 text-2xs text-muted [overflow-wrap:anywhere]">
                  {row.detail}
                </p>
              </div>
            </div>
            {row.action ? (
              <div className="flex items-center justify-end pl-7 @md:pl-0">
                <Button
                  variant="subtle"
                  className="min-h-7 px-2 text-2xs"
                  onClick={row.action.onClick}
                >
                  {row.action.label}
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </HomeCard>
    </HomeSection>
  )
}
