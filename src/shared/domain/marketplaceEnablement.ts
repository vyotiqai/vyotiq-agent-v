import type { MarketplaceKind, MarketplaceOverrides } from '../ipc'

export type MarketplaceOverrideKind = 'mcp' | 'skills' | 'plugins'

/** Resolve effective enablement: workspace override wins when present. */
export function effectiveMarketplaceEnabled(
  id: string,
  globalEnabled: boolean,
  overrides: MarketplaceOverrides | null | undefined,
  kind: MarketplaceOverrideKind
): boolean {
  const override = workspaceOverrideForId(overrides, kind, id)
  if (override !== undefined) return override
  return globalEnabled
}

/** Tri-state workspace Force on/off; `undefined` means use the global flag. */
export function workspaceOverrideForId(
  overrides: MarketplaceOverrides | null | undefined,
  kind: MarketplaceOverrideKind,
  id: string
): boolean | undefined {
  const map = overrides?.[kind]
  if (map && Object.prototype.hasOwnProperty.call(map, id)) {
    return map[id]
  }
  return undefined
}

export function marketplaceOverrideKind(kind: MarketplaceKind): MarketplaceOverrideKind {
  switch (kind) {
    case 'mcp':
      return 'mcp'
    case 'skill':
      return 'skills'
    case 'plugin':
      return 'plugins'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}
