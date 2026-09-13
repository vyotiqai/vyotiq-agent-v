import type {
  MarketplaceCatalogEntry,
  MarketplaceInstalledItem,
  McpServerStatus
} from '@shared/ipc'
import { kindLabel } from './marketplaceLabels'
import { mcpStatusClass, mcpStatusLabel } from './mcpStatus'

export type PackageActivityKind =
  | 'coming-soon'
  | 'connected'
  | 'enabled'
  | 'not-connected'
  | 'connect-failed'
  | 'disabled'
  | 'installed'
  | 'available'

export type PackageActivity = {
  kind: PackageActivityKind
  /** Short label for card footers / buttons */
  label: string
  /** Optional success/danger tint class for the label */
  className?: string
}

export type PackageActivityOptions = {
  /** Workspace Force on/off for this package (MCP / skill / plugin id). */
  workspaceEnabled?: boolean
  /** Nested MCP connection status for plugin packages. */
  nestedMcpStatuses?: Array<McpServerStatus | undefined>
}

export function packageActivity(
  entry: MarketplaceCatalogEntry,
  installed: MarketplaceInstalledItem | undefined,
  mcpStatus: McpServerStatus | undefined,
  options?: PackageActivityOptions
): PackageActivity {
  if (entry.installable === false) {
    return { kind: 'coming-soon', label: 'Coming soon' }
  }
  if (!installed) {
    return { kind: 'available', label: kindLabel(entry.kind) }
  }
  if (options?.workspaceEnabled === false) {
    if (entry.kind === 'mcp') {
      return {
        kind: 'disabled',
        label: mcpStatusLabel(mcpStatus, { workspaceEnabled: false }),
        className: mcpStatusClass(mcpStatus, { workspaceEnabled: false })
      }
    }
    return { kind: 'disabled', label: 'Force off here' }
  }
  if (!installed.enabled) {
    return { kind: 'disabled', label: 'Disabled' }
  }
  if (entry.kind === 'mcp') {
    return mcpPackageActivity(mcpStatus)
  }
  if (entry.kind === 'plugin' && options?.nestedMcpStatuses?.length) {
    const statuses = options.nestedMcpStatuses.filter(
      (s): s is McpServerStatus => s != null
    )
    if (statuses.length > 0) {
      const enabled = statuses.filter((s) => s.enabled)
      if (enabled.length === 0) {
        return { kind: 'disabled', label: 'Disabled' }
      }
      const connected = enabled.filter((s) => s.connected)
      const tools = connected.reduce((sum, s) => s.toolCount + sum, 0)
      if (connected.length === enabled.length && enabled.length === statuses.length) {
        return {
          kind: 'connected',
          label: `Connected · ${tools} tool${tools === 1 ? '' : 's'}`,
          className: 'text-success'
        }
      }
      if (connected.length > 0) {
        return {
          kind: 'enabled',
          label: `${connected.length}/${statuses.length} MCP connected`,
          className: 'text-success'
        }
      }
      const failed = enabled.find((s) => s.error?.trim())
      if (failed?.error) {
        const short =
          failed.error.length > 72
            ? `${failed.error.slice(0, 69)}…`
            : failed.error
        return {
          kind: 'connect-failed',
          label: `Connect failed · ${short}`,
          className: 'text-danger'
        }
      }
    }
  }
  return { kind: 'enabled', label: 'Enabled' }
}

function mcpPackageActivity(mcpStatus: McpServerStatus | undefined): PackageActivity {
  const label = mcpStatusLabel(mcpStatus)
  const className = mcpStatusClass(mcpStatus)
  if (!mcpStatus) {
    return { kind: 'not-connected', label, className }
  }
  if (!mcpStatus.enabled) {
    return { kind: 'disabled', label, className }
  }
  if (mcpStatus.connected) {
    return { kind: 'connected', label, className }
  }
  if (mcpStatus.error) {
    const short =
      mcpStatus.error.length > 72
        ? `${mcpStatus.error.slice(0, 69)}…`
        : mcpStatus.error
    return {
      kind: 'connect-failed',
      label: `Connect failed · ${short}`,
      className
    }
  }
  return { kind: 'not-connected', label, className }
}

/** Featured / detail trailing button label when installed. */
export function installedActionLabel(activity: PackageActivity): string {
  switch (activity.kind) {
    case 'connected':
      return 'Connected'
    case 'enabled':
      return 'Enabled'
    case 'not-connected':
      return 'Not connected'
    case 'connect-failed':
      return 'Connect failed'
    case 'disabled':
      return activity.label.startsWith('Force off') ? 'Force off' : 'Disabled'
    case 'installed':
    case 'coming-soon':
    case 'available':
      return 'Installed'
    default: {
      const _exhaustive: never = activity.kind
      return _exhaustive
    }
  }
}
