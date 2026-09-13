import type { MarketplaceKind } from '@shared/ipc'

export function kindLabel(kind: MarketplaceKind): string {
  switch (kind) {
    case 'mcp':
      return 'MCP'
    case 'skill':
      return 'Skill'
    case 'plugin':
      return 'Package'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

export function categoryTitle(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1)
}
