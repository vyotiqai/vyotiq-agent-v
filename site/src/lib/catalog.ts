/**
 * The extensions catalog bundled with the app (resources/marketplace), read at
 * build time so the page lists exactly what the app ships.
 */
import catalog from '../../../resources/marketplace/catalog.json'

const icons = import.meta.glob<string>('../../../resources/marketplace/icons/*.svg', { query: '?url', import: 'default', eager: true })

type Raw = (typeof catalog.packages)[number] & {
  verified?: boolean
  featuredRank?: number
  auth?: string
  requires?: string[]
}

export type Kind = 'mcp' | 'skill' | 'plugin'
export type Extension = {
  id: string
  name: string
  kind: Kind
  publisher: string
  description: string
  verified: boolean
  icon: string | null
  signIn: boolean
  requires: string[]
  featured: number
}

export const KIND_LABEL: Record<Kind, string> = { mcp: 'MCP server', skill: 'Skill', plugin: 'Package' }

const REQUIRES_LABEL: Record<string, string> = { node: 'Needs Node.js', uv: 'Needs uv', git: 'Needs git' }
export const requiresLabel = (r: string) => REQUIRES_LABEL[r] ?? `Needs ${r}`

export const extensions: Extension[] = (catalog.packages as Raw[])
  .map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind as Kind,
    publisher: p.publisher,
    description: p.description,
    verified: Boolean(p.verified),
    icon: icons[`../../../resources/marketplace/${p.iconPath}`] ?? null,
    signIn: p.auth === 'oauth' || p.auth === 'oauth-client',
    requires: p.requires ?? [],
    featured: p.featuredRank ?? 999
  }))
  .sort((a, b) => a.featured - b.featured || a.name.localeCompare(b.name))

export const counts = {
  all: extensions.length,
  mcp: extensions.filter((e) => e.kind === 'mcp').length,
  skill: extensions.filter((e) => e.kind === 'skill').length,
  plugin: extensions.filter((e) => e.kind === 'plugin').length
}
