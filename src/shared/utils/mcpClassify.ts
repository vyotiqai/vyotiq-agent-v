import type { McpDetectKind } from '../ipc'

/** Commands that start a local MCP server, so a line beginning with one is a stdio launch. */
export const STDIO_LAUNCHERS = new Set([
  'npx',
  'uvx',
  'uv',
  'node',
  'nodejs',
  'python',
  'python3',
  'pipx',
  'bun',
  'deno',
  'docker',
  'cmd',
  'cmd.exe',
  'powershell',
  'pwsh'
])

/** Split a command line on whitespace, keeping quoted runs whole and unquoted. */
export function tokenizeCommand(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return out.filter(Boolean)
}

/**
 * What a pasted line is, from its text alone — nothing is fetched or run. Main
 * detects from this, and the Add dialog reads it first so a git URL, the one
 * kind whose detection clones, waits for an explicit Detect.
 */
export function classifyMcpInput(raw: string): McpDetectKind {
  const input = raw.trim()
  if (!input) return 'unknown'

  if (input.startsWith('{') || input.startsWith('[')) {
    try {
      const parsed = JSON.parse(input) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>
        if (obj.mcpServers && typeof obj.mcpServers === 'object') return 'json'
        if (obj.command || obj.url) return 'json'
      }
    } catch {
      // fall through
    }
  }

  if (/^git@|^ssh:\/\/|^git:\/\//i.test(input) || /\.git$/i.test(input)) return 'git'

  if (/^https?:\/\//i.test(input)) {
    try {
      const u = new URL(input)
      const host = u.hostname.toLowerCase()
      if (
        host === 'github.com' ||
        host === 'www.github.com' ||
        host === 'gitlab.com' ||
        host === 'bitbucket.org' ||
        host.endsWith('.github.com')
      ) {
        return 'git'
      }
      return 'remote'
    } catch {
      return 'unknown'
    }
  }

  const tokens = tokenizeCommand(input)
  if (tokens.length > 0 && STDIO_LAUNCHERS.has(tokens[0]!.toLowerCase())) return 'stdio'

  // npm package: @scope/name or simple-name (no spaces, has letter)
  if (/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(input)) return 'npm'

  return 'unknown'
}
