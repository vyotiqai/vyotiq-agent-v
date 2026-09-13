import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import {
  DetectedMcpServerSchema,
  McpApplyDetectedRequestSchema,
  McpDetectRequestSchema,
  McpDetectResultSchema,
  McpImportExternalRequestSchema,
  McpImportExternalResultSchema,
  McpScanExternalRequestSchema,
  VyotiqMcpManifestSchema,
  VyotiqPluginManifestSchema,
  type DetectedMcpServer,
  type McpApplyDetectedResult,
  type McpDetectKind,
  type McpDetectResult,
  type McpImportExternalResult,
  type McpServer
} from '../../shared/ipc'
import { remoteMcpIdFromUrl } from '../../shared/utils/mcpAuth'
import { getSettings, setSettings, enqueueSettingsMutation } from '../settings/settings'
import { getWorkspaces } from '../workspace/workspaces'
import { getInstalledItem, readMarketplaceIndex } from './indexStore'
import { assertSafeGitCloneUrl } from './gitCloneUrl'
import { resolveInstalledPackageRoot } from './paths'
import { sanitizeMcpManifestEnv } from './sanitizeMcpEnv'

const execFileAsync = promisify(execFile)

const STDIO_LAUNCHERS = new Set([
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

function slugify(raw: string, max = 40): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max) || 'mcp'
  )
}

function shortHash(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function mcpServerDedupeKey(server: Pick<DetectedMcpServer, 'id' | 'transport' | 'command' | 'args' | 'url'>): string {
  if (server.transport === 'http' || server.transport === 'sse') {
    return `url:${(server.url ?? '').trim().toLowerCase()}`
  }
  const cmd = (server.command ?? '').trim().toLowerCase()
  const args = (server.args ?? []).map((a) => a.trim()).join('\0')
  return `stdio:${cmd}\0${args}`
}

/** Dedupe candidates without importing resolve.ts (avoids install↔mcpImport↔resolve cycle). */
function listDedupeCandidates(): Array<
  Pick<DetectedMcpServer, 'id' | 'transport' | 'command' | 'args' | 'url'> & {
    packageId?: string
  }
> {
  const settings = getSettings()
  const out: Array<
    Pick<DetectedMcpServer, 'id' | 'transport' | 'command' | 'args' | 'url'> & {
      packageId?: string
    }
  > = [...(settings.mcpServers ?? [])]
  for (const item of readMarketplaceIndex().items) {
    if (item.kind !== 'plugin' || !item.enabled) continue
    const root = resolveInstalledPackageRoot(item.packagePath)
    const manifestPath = join(root, 'vyotiq.plugin.json')
    if (!existsSync(manifestPath)) continue
    try {
      const plugin = VyotiqPluginManifestSchema.parse(
        JSON.parse(readFileSync(manifestPath, 'utf8'))
      )
      for (const rel of plugin.mcp) {
        const mcpManifestPath = join(root, rel, 'vyotiq.mcp.json')
        if (!existsSync(mcpManifestPath)) continue
        const nested = VyotiqMcpManifestSchema.parse(
          JSON.parse(readFileSync(mcpManifestPath, 'utf8'))
        )
        const id = `plugin-${plugin.id}-${nested.id}`.replace(/__/g, '-')
        out.push({
          id,
          transport: nested.transport ?? 'stdio',
          command: nested.command,
          args: nested.args,
          url: nested.url,
          packageId: item.id
        })
      }
    } catch {
      // skip invalid plugin
    }
  }
  return out
}

function existingDuplicate(server: DetectedMcpServer): boolean {
  const key = mcpServerDedupeKey(server)
  if (getInstalledItem(server.id)) return true
  return listDedupeCandidates().some((s) => {
    if (s.id === server.id) return true
    return mcpServerDedupeKey(s) === key
  })
}

function withDuplicateFlag(
  result: Omit<McpDetectResult, 'duplicate'> & {
    server?: DetectedMcpServer
    install?: { target: string }
  }
): McpDetectResult {
  let duplicate = result.server ? existingDuplicate(result.server) : false
  if (!duplicate && result.install?.target) {
    const target = result.install.target
    duplicate = Boolean(
      getInstalledItem(target) ||
        listDedupeCandidates().some((s) => s.packageId === target || s.id === target)
    )
  }
  return McpDetectResultSchema.parse({ ...result, duplicate })
}

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

function tokenizeCommand(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return out.filter(Boolean)
}

function serverFromStdioTokens(
  tokens: string[],
  nameHint?: string
): DetectedMcpServer {
  const command = tokens[0] ?? ''
  const args = tokens.slice(1)
  const pkgHint =
    args.find((a) => a.startsWith('@') || /^[a-z0-9-]+$/i.test(a)) ??
    nameHint ??
    command
  const id = `mcp-${slugify(pkgHint)}-${shortHash(tokens.join(' '))}`
  return DetectedMcpServerSchema.parse({
    id: id.includes('__') ? `mcp-${shortHash(tokens.join(' '))}` : id,
    name: nameHint ?? pkgHint,
    transport: 'stdio',
    command,
    args: args.length > 0 ? args : undefined,
    enabled: true,
    source: 'manual'
  })
}

function serverFromRemoteUrl(url: string, name?: string): DetectedMcpServer {
  const id = remoteMcpIdFromUrl(url, name)
  let display = name
  if (!display) {
    try {
      display = new URL(url).hostname
    } catch {
      display = 'Remote MCP'
    }
  }
  return DetectedMcpServerSchema.parse({
    id,
    name: display,
    transport: 'http',
    url,
    enabled: true,
    source: 'manual'
  })
}

/** Parse Cursor / Claude Desktop style `{ mcpServers: { id: { command, args, url, env } } }`. */
export function parseExternalMcpConfig(jsonText: string): DetectedMcpServer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error('Invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP config must be a JSON object')
  }
  const root = parsed as Record<string, unknown>
  const serversObj =
    root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : root.command || root.url
        ? { mcp: root }
        : null
  if (!serversObj) throw new Error('No mcpServers object found in config')

  const out: DetectedMcpServer[] = []
  for (const [key, value] of Object.entries(serversObj)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const id = slugify(key).replace(/__/g, '-') || `mcp-${shortHash(key)}`
    const url = typeof entry.url === 'string' ? entry.url.trim() : ''
    const command = typeof entry.command === 'string' ? entry.command.trim() : ''
    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === 'string')
      : undefined
    const env =
      entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
        ? Object.fromEntries(
            Object.entries(entry.env as Record<string, unknown>).filter(
              (kv): kv is [string, string] => typeof kv[1] === 'string'
            )
          )
        : undefined
    const transportRaw = typeof entry.transport === 'string' ? entry.transport : undefined
    const displayName =
      typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : key
    if (url) {
      const transport =
        transportRaw === 'sse' || transportRaw === 'http' ? transportRaw : 'http'
      out.push(
        DetectedMcpServerSchema.parse({
          id,
          name: displayName,
          transport,
          url,
          env,
          enabled: true,
          source: 'manual'
        })
      )
    } else if (command) {
      out.push(
        DetectedMcpServerSchema.parse({
          id,
          name: displayName,
          transport: 'stdio',
          command,
          args,
          env,
          enabled: true,
          source: 'manual'
        })
      )
    }
  }
  return out
}

function readJsonIfExists(path: string): unknown | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function detectFromMcpJsonFiles(root: string): DetectedMcpServer | null {
  const candidates = [
    join(root, '.cursor', 'mcp.json'),
    join(root, 'mcp.json'),
    join(root, '.mcp.json')
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const servers = parseExternalMcpConfig(readFileSync(path, 'utf8'))
      if (servers[0]) return servers[0]
    } catch {
      // continue
    }
  }
  return null
}

function detectFromReadme(root: string): DetectedMcpServer | null {
  const names = readdirSync(root).filter((n) => /^readme(\.|$)/i.test(n))
  for (const name of names) {
    let text: string
    try {
      text = readFileSync(join(root, name), 'utf8')
    } catch {
      continue
    }
    // Prefer fenced blocks mentioning mcp / serve / uvx / npx
    const fences = [...text.matchAll(/```(?:bash|sh|shell|json|jsonc)?\n([\s\S]*?)```/gi)]
    for (const fence of fences) {
      const body = fence[1] ?? ''
      // JSON mcpServers in README
      if (body.includes('mcpServers') || body.includes('"command"')) {
        try {
          const servers = parseExternalMcpConfig(body.trim())
          if (servers[0]) return servers[0]
        } catch {
          // try line-based
        }
      }
      for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim().replace(/^#+\s*/, '').replace(/^\$\s*/, '')
        if (!trimmed || trimmed.startsWith('#')) continue
        const tokens = tokenizeCommand(trimmed)
        if (tokens.length === 0) continue
        const head = tokens[0]!.toLowerCase()
        if (STDIO_LAUNCHERS.has(head) || /serve/i.test(trimmed)) {
          // Prefer lines with serve / mcp
          if (/mcp|serve|uvx|npx/i.test(trimmed)) {
            return serverFromStdioTokens(tokens, basenameHint(root))
          }
        }
      }
    }
    // Loose line search
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim().replace(/^\$\s*/, '')
      if (/^(uvx|npx)\s+\S+/i.test(trimmed) && /serve|mcp/i.test(trimmed)) {
        return serverFromStdioTokens(tokenizeCommand(trimmed), basenameHint(root))
      }
      if (/^[a-z0-9_-]+\s+serve\b/i.test(trimmed)) {
        const tokens = tokenizeCommand(trimmed)
        // Prefer uvx wrapper when package looks like a CLI
        if (tokens[0] && !STDIO_LAUNCHERS.has(tokens[0].toLowerCase())) {
          return serverFromStdioTokens(['uvx', ...tokens], basenameHint(root))
        }
        return serverFromStdioTokens(tokens, basenameHint(root))
      }
    }
  }
  return null
}

function basenameHint(root: string): string {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || 'MCP server'
}

function detectFromPackageJson(root: string): DetectedMcpServer | null {
  const pkg = readJsonIfExists(join(root, 'package.json')) as Record<string, unknown> | null
  if (!pkg) return null
  const name = typeof pkg.name === 'string' ? pkg.name : basenameHint(root)
  if (pkg.mcpServers && typeof pkg.mcpServers === 'object') {
    try {
      const servers = parseExternalMcpConfig(JSON.stringify({ mcpServers: pkg.mcpServers }))
      if (servers[0]) return servers[0]
    } catch {
      // continue
    }
  }
  const bin = pkg.bin
  if (typeof bin === 'string') {
    return serverFromStdioTokens(['npx', '-y', name], name)
  }
  if (bin && typeof bin === 'object') {
    return serverFromStdioTokens(['npx', '-y', name], name)
  }
  return null
}

function detectFromPyproject(root: string): DetectedMcpServer | null {
  const path = join(root, 'pyproject.toml')
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const nameMatch = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m)
  const name = nameMatch?.[1] ?? basenameHint(root)
  // scripts.serve or project.scripts
  if (/serve\s*=/i.test(text) || /\[project\.scripts\]/i.test(text)) {
    return serverFromStdioTokens(['uvx', name, 'serve'], name)
  }
  if (/mcp/i.test(text)) {
    return serverFromStdioTokens(['uvx', name], name)
  }
  return null
}

export type GitDetectResult = {
  server: DetectedMcpServer
  confidence: 'high' | 'medium' | 'low'
  warnings: string[]
  vyotiq: boolean
}

function tryReadVyotiqMcp(root: string): DetectedMcpServer | null {
  const manifestPath = join(root, 'vyotiq.mcp.json')
  if (!existsSync(manifestPath)) return null
  try {
    const manifest = VyotiqMcpManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, 'utf8'))
    )
    return DetectedMcpServerSchema.parse({
      id: manifest.id,
      name: manifest.name,
      transport: manifest.transport ?? 'stdio',
      command: manifest.command,
      args: manifest.args,
      env: sanitizeMcpManifestEnv(manifest.env),
      url: manifest.url,
      enabled: true,
      source: 'manual'
    })
  } catch {
    return null
  }
}

/** Detect MCP launch config from a cloned/extracted package root. */
export function detectFromGitRepo(root: string): GitDetectResult {
  const warnings: string[] = []
  const vyotiqServer = tryReadVyotiqMcp(root)
  if (vyotiqServer) {
    return { server: vyotiqServer, confidence: 'high', warnings, vyotiq: true }
  }

  const fromConfig = detectFromMcpJsonFiles(root)
  if (fromConfig) {
    return { server: fromConfig, confidence: 'high', warnings, vyotiq: false }
  }

  const fromReadme = detectFromReadme(root)
  if (fromReadme) {
    return { server: fromReadme, confidence: 'medium', warnings, vyotiq: false }
  }

  const fromPkg = detectFromPackageJson(root)
  if (fromPkg) {
    return { server: fromPkg, confidence: 'medium', warnings, vyotiq: false }
  }

  const fromPy = detectFromPyproject(root)
  if (fromPy) {
    warnings.push('Detected via pyproject.toml — verify the command works on your PATH (uv recommended).')
    return { server: fromPy, confidence: 'medium', warnings, vyotiq: false }
  }

  const empty = DetectedMcpServerSchema.parse({
    id: `mcp-${slugify(basenameHint(root))}-${shortHash(root)}`,
    name: basenameHint(root),
    transport: 'stdio',
    command: '',
    enabled: true,
    source: 'manual'
  })
  warnings.push(
    'Could not auto-detect an MCP launch command. Fill in command and args, then add.'
  )
  return { server: empty, confidence: 'low', warnings, vyotiq: false }
}

/**
 * Write a synthetic vyotiq.mcp.json when a non-Vyotiq tree has a detectable MCP command.
 * Returns true if a manifest was written.
 */
export function synthesizeVyotiqMcpManifest(root: string): boolean {
  if (existsSync(join(root, 'vyotiq.mcp.json'))) return false
  const detected = detectFromGitRepo(root)
  if (detected.vyotiq) return false
  if (!(detected.server.command ?? '').trim() && !(detected.server.url ?? '').trim()) return false
  const s = detected.server
  const manifest = {
    schemaVersion: 1 as const,
    kind: 'mcp' as const,
    id: s.id.replace(/^mcp-/, '').slice(0, 48) || slugify(s.name),
    name: s.name,
    version: '1.0.0',
    description: `Auto-detected MCP from external package (${s.name})`,
    transport: s.transport ?? 'stdio',
    ...(s.command ? { command: s.command } : {}),
    ...(s.args?.length ? { args: s.args } : {}),
    ...(s.env ? { env: sanitizeMcpManifestEnv(s.env) } : {}),
    ...(s.url ? { url: s.url } : {})
  }
  // Avoid __ in id
  if (manifest.id.includes('__')) {
    manifest.id = `ext-${shortHash(manifest.id)}`
  }
  writeFileSync(join(root, 'vyotiq.mcp.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return true
}

async function shallowClone(gitUrl: string): Promise<{ root: string; cleanup: () => void }> {
  const cloneUrl = assertSafeGitCloneUrl(gitUrl)
  const tmp = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-detect-'))
  const cleanup = (): void => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
  const cloneDir = join(tmp, 'repo')
  await execFileAsync(
    'git',
    ['-c', 'protocol.file.allow=never', 'clone', '--depth', '1', cloneUrl, cloneDir],
    {
      timeout: 120_000
    }
  )
  return { root: cloneDir, cleanup }
}

function normalizeGitHubUrl(input: string): string {
  const trimmed = input.trim().replace(/\/$/, '')
  try {
    const u = new URL(trimmed)
    if (u.hostname.replace(/^www\./, '') === 'github.com') {
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts.length >= 2) {
        return `https://github.com/${parts[0]}/${parts[1]!.replace(/\.git$/, '')}.git`
      }
    }
  } catch {
    // keep as-is
  }
  return trimmed
}

function requiresRemoteAck(servers: DetectedMcpServer[]): boolean {
  // Any untrusted MCP registration (stdio host process or remote URL) needs ack.
  return servers.some(
    (s) => Boolean((s.url ?? '').trim()) || Boolean((s.command ?? '').trim())
  )
}

const REMOTE_ACK_WARNING =
  'Acknowledge marketplace / MCP installs in Marketplace → Manage (Package Registry) before adding MCP servers.'

export async function detectMcpInput(rawInput: unknown): Promise<McpDetectResult> {
  const { input } = McpDetectRequestSchema.parse(rawInput)
  const kind = classifyMcpInput(input)
  const settings = getSettings()
  const needsAck = kind === 'git' || kind === 'npm' || kind === 'remote'
  if (needsAck && !settings.marketplace?.remoteInstallAcked) {
    return withDuplicateFlag({
      kind,
      confidence: 'low',
      warnings: [REMOTE_ACK_WARNING]
    })
  }

  if (kind === 'json') {
    try {
      const servers = parseExternalMcpConfig(input)
      const server = servers[0]
      if (!server) {
        return withDuplicateFlag({
          kind: 'json',
          confidence: 'low',
          warnings: ['JSON parsed but no MCP servers found.']
        })
      }
      if (requiresRemoteAck(servers) && !settings.marketplace?.remoteInstallAcked) {
        return withDuplicateFlag({
          kind: 'json',
          confidence: 'low',
          warnings: [REMOTE_ACK_WARNING]
        })
      }
      const warnings =
        servers.length > 1
          ? [`Found ${servers.length} servers; preview shows the first. Use Import for all.`]
          : []
      return withDuplicateFlag({
        kind: 'json',
        confidence: 'high',
        server,
        warnings
      })
    } catch (err) {
      return withDuplicateFlag({
        kind: 'json',
        confidence: 'low',
        warnings: [err instanceof Error ? err.message : String(err)]
      })
    }
  }

  if (kind === 'remote') {
    const server = serverFromRemoteUrl(input)
    return withDuplicateFlag({
      kind: 'remote',
      confidence: 'high',
      server,
      warnings: []
    })
  }

  if (kind === 'stdio') {
    const tokens = tokenizeCommand(input.trim())
    const server = serverFromStdioTokens(tokens)
    return withDuplicateFlag({
      kind: 'stdio',
      confidence: 'high',
      server,
      warnings: []
    })
  }

  if (kind === 'npm') {
    const name = input.trim()
    const server = serverFromStdioTokens(['npx', '-y', name], name)
    return withDuplicateFlag({
      kind: 'npm',
      confidence: 'medium',
      server,
      warnings: [
        'Suggested stdio launch via npx. Use Marketplace → Install npm for Vyotiq-packaged npm packages.'
      ]
    })
  }

  if (kind === 'git') {
    const gitUrl = normalizeGitHubUrl(input)
    let cleanup: (() => void) | undefined
    try {
      const cloned = await shallowClone(gitUrl)
      cleanup = cloned.cleanup
      const detected = detectFromGitRepo(cloned.root)
      if (detected.vyotiq) {
        return withDuplicateFlag({
          kind: 'vyotiq-package',
          confidence: 'high',
          install: { source: 'git', target: gitUrl },
          server: detected.server,
          warnings: []
        })
      }
      if (
        existsSync(join(cloned.root, 'vyotiq.plugin.json')) ||
        existsSync(join(cloned.root, 'SKILL.md')) ||
        existsSync(join(cloned.root, 'skill.md'))
      ) {
        return withDuplicateFlag({
          kind: 'vyotiq-package',
          confidence: 'high',
          install: { source: 'git', target: gitUrl },
          warnings: []
        })
      }
      return withDuplicateFlag({
        kind: 'git',
        confidence: detected.confidence,
        server: detected.server,
        warnings: detected.warnings
      })
    } catch (err) {
      return withDuplicateFlag({
        kind: 'git',
        confidence: 'low',
        warnings: [
          err instanceof Error ? err.message : String(err),
          'Clone failed. Check the URL and that git is on PATH.'
        ]
      })
    } finally {
      cleanup?.()
    }
  }

  return withDuplicateFlag({
    kind: 'unknown',
    confidence: 'low',
    server: DetectedMcpServerSchema.parse({
      id: `mcp-${randomUUID()}`,
      name: 'New MCP server',
      transport: 'stdio',
      command: '',
      enabled: true,
      source: 'manual'
    }),
    warnings: ['Could not classify input. Enter a command manually or use Advanced.']
  })
}

/** Apply a detected manual MCP server into settings. Marketplace installs are handled by the IPC layer. */
export function applyDetectedManualMcp(raw: unknown): McpApplyDetectedResult {
  const req = McpApplyDetectedRequestSchema.parse(raw)
  if (req.install && !req.server) {
    throw new Error('Marketplace install must be applied via marketplace:install')
  }
  if (!req.server) {
    throw new Error('Nothing to apply: provide server or install')
  }
  const server = DetectedMcpServerSchema.parse({
    ...req.server,
    source: 'manual',
    enabled: req.server.enabled ?? true,
    env: sanitizeMcpManifestEnv(req.server.env)
  })
  if (!(server.command ?? '').trim() && !(server.url ?? '').trim()) {
    throw new Error('Command or URL is required before adding')
  }
  // Validate transport requirements
  if ((server.transport === 'http' || server.transport === 'sse') && !(server.url ?? '').trim()) {
    throw new Error('URL is required for remote MCP')
  }
  if ((server.transport === 'stdio' || !server.transport) && !(server.command ?? '').trim()) {
    throw new Error('Command is required for stdio MCP')
  }

  const settings = getSettings()
  if (!settings.marketplace?.remoteInstallAcked) {
    throw new Error(
      'Acknowledge marketplace / MCP installs in Marketplace → Manage (Package Registry) before adding MCP servers.'
    )
  }
  const list = [...(settings.mcpServers ?? [])]
  const idx = list.findIndex((s) => s.id === server.id)
  if (idx >= 0) {
    if (!req.overwrite) {
      throw new Error(
        `MCP id "${server.id}" already exists. Enable overwrite or choose a different id.`
      )
    }
    list[idx] = server as McpServer
  } else {
    // Also check fingerprint duplicate
    const key = mcpServerDedupeKey(server)
    const dup = list.find((s) => mcpServerDedupeKey(s) === key)
    if (dup && !req.overwrite) {
      throw new Error(
        `An equivalent MCP server is already configured as "${dup.name}" (${dup.id}).`
      )
    }
    if (dup && req.overwrite) {
      const di = list.findIndex((s) => s.id === dup.id)
      if (di >= 0) list[di] = server as McpServer
      else list.push(server as McpServer)
    } else {
      list.push(server as McpServer)
    }
  }
  setSettings({ mcpServers: list })
  return { applied: 'manual', serverId: server.id }
}

export function defaultExternalConfigPaths(workspacePath?: string | null): string[] {
  const home = homedir()
  const paths: string[] = []
  const ws = workspacePath?.trim() || getWorkspaces().activePath
  if (ws) {
    paths.push(join(ws, '.cursor', 'mcp.json'))
    paths.push(join(ws, 'mcp.json'))
  }
  // Cursor user-level
  paths.push(join(home, '.cursor', 'mcp.json'))
  if (process.platform === 'darwin') {
    paths.push(join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'mcp.json'))
    paths.push(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    paths.push(join(appData, 'Cursor', 'User', 'globalStorage', 'mcp.json'))
    paths.push(join(appData, 'Claude', 'claude_desktop_config.json'))
  } else {
    paths.push(join(home, '.config', 'Cursor', 'User', 'globalStorage', 'mcp.json'))
    paths.push(join(home, '.config', 'Claude', 'claude_desktop_config.json'))
  }
  return paths
}

const ALLOWED_EXTERNAL_MCP_BASENAMES = new Set(['mcp.json', 'claude_desktop_config.json'])

function isPathUnderRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Only allow known MCP config filenames under home / AppData / open workspaces
 * (or exact default scan paths). Blocks arbitrary filesystem reads via IPC.
 */
export function isAllowedExternalMcpConfigPath(filePath: string): boolean {
  const resolved = resolve(filePath)
  const name = basename(resolved).toLowerCase()
  if (!ALLOWED_EXTERNAL_MCP_BASENAMES.has(name)) return false

  const defaults = defaultExternalConfigPaths().map((p) => resolve(p))
  if (defaults.includes(resolved)) return true

  const roots: string[] = [resolve(homedir())]
  if (process.env.APPDATA) roots.push(resolve(process.env.APPDATA))
  if (process.env.LOCALAPPDATA) roots.push(resolve(process.env.LOCALAPPDATA))
  try {
    const state = getWorkspaces()
    if (state.activePath) roots.push(resolve(state.activePath))
    for (const p of state.openPaths ?? []) roots.push(resolve(p))
    for (const p of state.recentPaths ?? []) roots.push(resolve(p))
  } catch {
    // workspaces unavailable in some unit fixtures
  }

  return roots.some((root) => isPathUnderRoot(resolved, root))
}

function filterExternalMcpPaths(paths: string[], warnings: string[]): string[] {
  const out: string[] = []
  for (const path of paths) {
    if (isAllowedExternalMcpConfigPath(path)) {
      out.push(path)
      continue
    }
    warnings.push(
      `${path}: skipped — only mcp.json / claude_desktop_config.json under home, AppData, or an open workspace are allowed`
    )
  }
  return out
}

export function scanExternalMcpConfigs(raw?: unknown): McpImportExternalResult {
  const req = McpScanExternalRequestSchema.parse(raw ?? {})
  const warnings: string[] = []
  const scannedPaths = filterExternalMcpPaths(
    req.paths?.length ? req.paths : defaultExternalConfigPaths(),
    warnings
  )
  const byId = new Map<string, DetectedMcpServer>()

  for (const path of scannedPaths) {
    if (!existsSync(path)) continue
    try {
      const servers = parseExternalMcpConfig(readFileSync(path, 'utf8'))
      for (const s of servers) {
        if (!byId.has(s.id)) byId.set(s.id, s)
      }
    } catch (err) {
      warnings.push(`${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return McpImportExternalResultSchema.parse({
    preview: [...byId.values()],
    applied: 0,
    skipped: 0,
    warnings,
    scannedPaths
  })
}

export async function importExternalMcpServers(raw: unknown): Promise<McpImportExternalResult> {
  const req = McpImportExternalRequestSchema.parse(raw)
  const warnings: string[] = []
  const scannedPaths = filterExternalMcpPaths(
    req.paths?.length
      ? req.paths
      : req.json || req.servers?.length
        ? []
        : defaultExternalConfigPaths(),
    warnings
  )
  const byId = new Map<string, DetectedMcpServer>()

  if (req.servers?.length) {
    for (const s of req.servers) {
      byId.set(s.id, DetectedMcpServerSchema.parse(s))
    }
  }

  if (req.json?.trim()) {
    try {
      for (const s of parseExternalMcpConfig(req.json)) {
        if (!byId.has(s.id)) byId.set(s.id, s)
      }
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err))
    }
  }

  for (const path of scannedPaths) {
    if (!existsSync(path)) continue
    try {
      for (const s of parseExternalMcpConfig(readFileSync(path, 'utf8'))) {
        if (!byId.has(s.id)) byId.set(s.id, s)
      }
    } catch (err) {
      warnings.push(`${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let preview = [...byId.values()]
  if (req.selectedIds?.length) {
    const selected = new Set(req.selectedIds)
    preview = preview.filter((s) => selected.has(s.id))
  }

  const settings = getSettings()
  if (requiresRemoteAck(preview) && !settings.marketplace?.remoteInstallAcked) {
    throw new Error(REMOTE_ACK_WARNING)
  }

  let list =
    req.mode === 'replace'
      ? (settings.mcpServers ?? []).filter((s) => s.source === 'marketplace')
      : [...(settings.mcpServers ?? [])]

  let applied = 0
  let skipped = 0
  const effective = listDedupeCandidates()
  for (const server of preview) {
    if (!(server.command ?? '').trim() && !(server.url ?? '').trim()) {
      skipped += 1
      continue
    }
    const existingIdx = list.findIndex((s) => s.id === server.id)
    const key = mcpServerDedupeKey(server)
    const fpIdx = list.findIndex((s) => mcpServerDedupeKey(s) === key)
    const effectiveDup = effective.some(
      (s) => s.id === server.id || mcpServerDedupeKey(s) === key
    )
    if (existingIdx >= 0 || fpIdx >= 0 || (req.mode === 'merge' && effectiveDup)) {
      if (req.mode === 'merge') {
        skipped += 1
        continue
      }
      const idx = existingIdx >= 0 ? existingIdx : fpIdx
      if (idx >= 0) {
        list[idx] = { ...server, source: 'manual', env: sanitizeMcpManifestEnv(server.env) } as McpServer
        applied += 1
        continue
      }
    }
    list.push({
      ...server,
      source: 'manual',
      env: sanitizeMcpManifestEnv(server.env)
    } as McpServer)
    applied += 1
  }

  await enqueueSettingsMutation(() => setSettings({ mcpServers: list }))
  return McpImportExternalResultSchema.parse({
    preview,
    applied,
    skipped,
    warnings,
    scannedPaths
  })
}
