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
  | 'needs-auth'
  | 'connect-failed'
  | 'disabled'
  | 'installed'
  | 'available'

/**
 * The one control that moves this package forward.
 *
 * Every installed package used to render the same permanently disabled chip,
 * so a server that only needed a sign-in looked identical to one that had
 * failed, and neither could be acted on without going to Manage and opening
 * Advanced. A state that has a way out now says what it is.
 */
export type PackageActivityAction = {
  kind: 'sign-in' | 'retry'
  label: string
}

export type PackageActivity = {
  kind: PackageActivityKind
  /** Short label for card footers / buttons */
  label: string
  /** Optional success/danger tint class for the label */
  className?: string
  action?: PackageActivityAction
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
    return mcpPackageActivity(mcpStatus, entry)
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
      const needsAuth = enabled.find((s) => s.errorKind === 'sign-in')
      if (needsAuth) {
        return {
          kind: 'needs-auth',
          label: 'Sign in to connect',
          action: { kind: 'sign-in', label: 'Sign in' }
        }
      }
      const failed = enabled.find((s) => s.error?.trim())
      if (failed?.error) {
        return {
          kind: 'connect-failed',
          label: `Connect failed · ${shortError(failed.error)}`,
          className: 'text-danger',
          ...(failed.errorKind === 'network' ? RETRY : {})
        }
      }
    }
  }
  return { kind: 'enabled', label: 'Enabled' }
}

const RETRY = { action: { kind: 'retry', label: 'Retry' } } as const

/** Card width is finite and the useful part of a failure is its first clause. */
function shortError(error: string): string {
  return error.length > 72 ? `${error.slice(0, 69)}…` : error
}

function mcpPackageActivity(
  mcpStatus: McpServerStatus | undefined,
  entry: MarketplaceCatalogEntry
): PackageActivity {
  const label = mcpStatusLabel(mcpStatus)
  const className = mcpStatusClass(mcpStatus)
  /** The server expects a credential, so connecting is a sign-in, not a retry. */
  const wantsAuth = Boolean(entry.auth && entry.auth !== 'none')
  if (!mcpStatus) {
    return { kind: 'not-connected', label, className, ...RETRY }
  }
  if (!mcpStatus.enabled) {
    return { kind: 'disabled', label, className }
  }
  if (mcpStatus.connected) {
    return { kind: 'connected', label, className }
  }
  // Mid-connect: no control, because the thing a button would start is
  // already running, and no failure text, because there is not one yet.
  if (mcpStatus.connecting) {
    return { kind: 'not-connected', label, className }
  }
  // Needing a sign-in is the expected first state of an OAuth server, not a
  // failure: no red, and the button does the thing the state is asking for.
  if (mcpStatus.errorKind === 'sign-in' || (wantsAuth && !mcpStatus.hasAuthToken)) {
    return {
      kind: 'needs-auth',
      label: 'Sign in to connect',
      action: { kind: 'sign-in', label: 'Sign in' }
    }
  }
  if (mcpStatus.error) {
    return {
      kind: 'connect-failed',
      label: `Connect failed · ${shortError(mcpStatus.error)}`,
      className,
      // A missing binary or a non-Git workspace will fail identically on the
      // next attempt, so only a network failure gets a Retry.
      ...(mcpStatus.errorKind === 'network' ? RETRY : {})
    }
  }
  return { kind: 'not-connected', label, className, ...RETRY }
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
    case 'needs-auth':
      return 'Sign in'
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
