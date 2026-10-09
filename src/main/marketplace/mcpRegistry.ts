import type { McpRegistryServer } from '../../shared/ipc'

/**
 * Search the official MCP Registry (registry.modelcontextprotocol.io) beside
 * the bundled catalog. A result is turned into the line a person would paste
 * into Add server — `npx -y <package>`, `uvx <package>`, a docker run, or the
 * remote URL — so it goes through the same detection, review and approval as
 * anything pasted. Nothing is installed from here.
 */

export const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers'
const SEARCH_LIMIT = 30
const SEARCH_TIMEOUT_MS = 12_000

type Json = Record<string, unknown>

function obj(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(obj).filter((v): v is Json => v !== null) : []
}

/** A package's launch line, by the registry it is published to. */
function packageLaunch(pkg: Json): string | null {
  const registry = (str(pkg.registryType) ?? str(pkg.registry_type) ?? str(pkg.registry_name) ?? '').toLowerCase()
  const id = str(pkg.identifier) ?? str(pkg.name)
  if (!id || /\s/.test(id)) return null
  switch (registry) {
    case 'npm':
      return `npx -y ${id}`
    case 'pypi':
      return `uvx ${id}`
    case 'oci':
    case 'docker':
      return `docker run -i --rm ${id}`
    default:
      return null
  }
}

function envVars(pkg: Json): McpRegistryServer['env'] {
  return list(pkg.environmentVariables ?? pkg.environment_variables)
    .map((v) => ({
      name: str(v.name) ?? '',
      description: str(v.description) ?? '',
      required: v.isRequired === true || v.is_required === true,
      secret: v.isSecret === true || v.is_secret === true
    }))
    .filter((v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name))
}

/** One registry entry as the dialog lists it; null when it offers nothing Agent V can launch. */
export function parseRegistryServer(raw: unknown): McpRegistryServer | null {
  const outer = obj(raw)
  const server = obj(outer?.server) ?? outer
  if (!server) return null
  const name = str(server.name)
  if (!name) return null
  const remote = list(server.remotes).find((r) => {
    const type = (str(r.type) ?? str(r.transport_type) ?? '').toLowerCase()
    return (type === 'streamable-http' || type === 'sse' || type === 'http') && str(r.url)?.startsWith('https://')
  })
  const pkg = list(server.packages).find((p) => packageLaunch(p) !== null)
  const launch = remote ? str(remote.url) : pkg ? packageLaunch(pkg) : null
  if (!launch) return null
  const repository = obj(server.repository)
  return {
    name,
    title: str(server.title),
    description: str(server.description) ?? '',
    version: str(server.version) ?? str(obj(server.version_detail)?.version),
    repository: str(repository?.url),
    launch,
    remote: Boolean(remote),
    env: pkg && !remote ? envVars(pkg) : []
  }
}

/** The registry's answer as a list, newest version of each name, launchable ones only. */
export function parseRegistryResponse(raw: unknown): McpRegistryServer[] {
  const body = obj(raw)
  const byName = new Map<string, McpRegistryServer>()
  for (const item of list(body?.servers)) {
    const parsed = parseRegistryServer(item)
    if (parsed) byName.set(parsed.name, parsed)
  }
  return [...byName.values()]
}

export async function searchMcpRegistry(
  query: string,
  fetchImpl: typeof fetch = fetch
): Promise<McpRegistryServer[]> {
  const url = new URL(MCP_REGISTRY_URL)
  if (query.trim()) url.searchParams.set('search', query.trim())
  url.searchParams.set('limit', String(SEARCH_LIMIT))
  url.searchParams.set('version', 'latest')
  const res = await fetchImpl(url.toString(), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`The MCP Registry answered ${res.status}.`)
  return parseRegistryResponse(await res.json())
}
