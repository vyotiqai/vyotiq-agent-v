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
 * What to say and what to offer, per kind of failure.
 *
 * Every row used to read "<name> is not connected — the server is enabled but
 * reported no connection" above a Manage button, which is the same sentence
 * whether the server wants a sign-in, timed out, or is missing a binary, and
 * the same two-hop route to the fix in all three cases. Main now classifies
 * the failure where the original error still exists, so the row can name it
 * and offer the one control that resolves it.
 */
function mcpRow(
  server: McpHealthIssue,
  onOpenMcpServer?: (serverId: string) => void,
  onRetry?: () => void
): EnvironmentRow {
  const base = { id: `mcp:${server.id}`, icon: 'plug' as IconName }
  const manage = onOpenMcpServer
    ? { action: { label: 'Manage', onClick: () => onOpenMcpServer(server.id) } }
    : {}

  if (server.errorKind === 'sign-in') {
    return {
      ...base,
      title: `Sign in to ${server.name}`,
      detail: `${server.name} is installed and enabled. Its tools load once you sign in.`,
      ...(onOpenMcpServer
        ? { action: { label: 'Sign in', onClick: () => onOpenMcpServer(server.id) } }
        : {})
    }
  }
  if (server.errorKind === 'network') {
    return {
      ...base,
      title: `${server.name} could not be reached`,
      detail: server.error ?? 'The connection failed.',
      ...(onRetry ? { action: { label: 'Retry', onClick: onRetry } } : manage)
    }
  }
  return {
    ...base,
    title: `${server.name} is not connected`,
    detail: server.error ?? 'The server is enabled but reported no connection.',
    ...manage
  }
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
  onOpenMcpServer,
  onRetryMcp
}: {
  providerIssue: ProviderIssue | null
  mcpIssues: readonly McpHealthIssue[]
  onOpenProviderSettings?: () => void
  onOpenMcpServer?: (serverId: string) => void
  /** Drops the sessions and reconnects — only ever from a press. */
  onRetryMcp?: () => void
}) {
  const rows: EnvironmentRow[] = []
  if (providerIssue) {
    rows.push({
      id: 'provider',
      icon: 'mcp',
      title: `${providerIssue.label} has no API key`,
      detail: 'Runs cannot start until a key is saved for this provider.',
      ...(onOpenProviderSettings
        ? { action: { label: 'Add key', onClick: onOpenProviderSettings } }
        : {})
    })
  }
  for (const server of mcpIssues) {
    rows.push(mcpRow(server, onOpenMcpServer, onRetryMcp))
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
                <Button size="xs"
                  variant="subtle"
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
