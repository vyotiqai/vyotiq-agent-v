import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import { createHash, randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  MarketplaceInstallRequestSchema,
  type MarketplaceInstallRequest,
  type MarketplaceInstallResult,
  type MarketplaceInstallSource,
  type MarketplaceInstalledItem,
  type MarketplaceKind,
  VyotiqMcpManifestSchema,
  VyotiqPluginManifestSchema,
  type McpServer
} from '../../shared/ipc'
import { parseSkillFrontmatter, skillPackageVersion } from '../agent/skills/parse'
import { resolveSkillMdPath, SKILL_MD, LEGACY_SKILL_MD } from '../agent/skills/paths'
import { getSettings, setSettings, enqueueSettingsMutation } from '../settings/settings'
import { formatError } from '../../shared/errors'
import { logger } from '../../shared/logger'
import { browseCatalog, refreshRemoteCatalog } from './catalog'
import { getInstalledItem, readMarketplaceIndex, upsertInstalledItem } from './indexStore'
import {
  bundledPackagePath,
  marketplacePackageDir,
  marketplacePackagesRoot,
  resolveInstalledPackageRoot
} from './paths'
import { remoteMcpIdFromUrl, headersWithoutAuthorization } from '../../shared/utils/mcpAuth'
import { setMcpAuthToken } from '../settings/secrets'
import { synthesizeVyotiqMcpManifest } from './mcpImport'
import { assertSafeGitCloneUrl } from './gitCloneUrl'
import { sanitizeMcpManifestEnv } from './sanitizeMcpEnv'
import { withCompatibleUvxArgs } from '../agent/mcp/uvxCompat'
import { downloadPublicUrlToFile } from '../agent/tools/webFetch'

const execFileAsync = promisify(execFile)

/** Same shape as mcpImport npm classification — names only, no paths/URLs/flags. */
const NPM_PACK_TARGET_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

/** Reject path/URL/flag-shaped targets before `npm pack`. */
export function assertSafeNpmPackTarget(target: string): string {
  const t = target.trim()
  // Scoped names use `/` (@scope/name). Reject Windows paths, URLs, and flags.
  if (
    !t ||
    t.startsWith('-') ||
    t.includes('..') ||
    /\\/.test(t) ||
    t.includes('://') ||
    /^[a-zA-Z]:/.test(t)
  ) {
    throw new Error('Invalid npm package name for install')
  }
  if (!NPM_PACK_TARGET_RE.test(t)) {
    throw new Error('Invalid npm package name for install')
  }
  return t
}

/** Catalog downloads must stay on the configured registry origin. */
export function assertRegistryDownloadUrl(downloadUrl: string, registryUrl: string): string {
  const reg = registryUrl.trim().replace(/\/$/, '')
  if (!reg) {
    throw new Error('No registry URL configured for catalog download')
  }
  let download: URL
  let registry: URL
  try {
    download = new URL(downloadUrl)
    registry = new URL(reg)
  } catch {
    throw new Error('Invalid download or registry URL')
  }
  // Network registries must be https only. The download helper is http(s)-only
  // (no file:// registry exists), so plain http is rejected outright.
  if (registry.protocol !== 'https:') {
    throw new Error('Marketplace registry URL must use https: (plain http is not allowed)')
  }
  if (download.protocol !== registry.protocol || download.host !== registry.host) {
    throw new Error('Catalog download URL must match the configured registry origin')
  }
  return downloadUrl
}

export type DetectedPackage = {
  kind: MarketplaceKind
  id: string
  name: string
  version: string
  description: string
  root: string
}

function hasSkillPackageMarker(dir: string): boolean {
  return resolveSkillMdPath(dir) != null
}

export function detectPackageAt(root: string): DetectedPackage {
  const mcpPath = join(root, 'vyotiq.mcp.json')
  const pluginPath = join(root, 'vyotiq.plugin.json')
  const skillPath = resolveSkillMdPath(root)

  if (existsSync(mcpPath)) {
    const manifest = VyotiqMcpManifestSchema.parse(JSON.parse(readFileSync(mcpPath, 'utf8')))
    return {
      kind: 'mcp',
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      root
    }
  }
  if (existsSync(pluginPath)) {
    const manifest = VyotiqPluginManifestSchema.parse(JSON.parse(readFileSync(pluginPath, 'utf8')))
    return {
      kind: 'plugin',
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      root
    }
  }
  if (skillPath) {
    const skill = parseSkillFrontmatter(readFileSync(skillPath, 'utf8'))
    return {
      kind: 'skill',
      id: skill.name,
      name: skill.name,
      version: skillPackageVersion(skill),
      description: skill.description,
      root
    }
  }
  throw new Error(
    'Not a Vyotiq package (need vyotiq.mcp.json, vyotiq.plugin.json, or SKILL.md)'
  )
}

/**
 * Reject zip-slip / symlink escapes after extract. Throws and leaves callers to
 * clean up the temp tree.
 */
export function isContainmentOrSymlinkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /symlink|escaped destination|extract rejected|Archive extract/i.test(msg)
}

export { assertSafeGitCloneUrl }

/** @internal Exported for unit tests — zip-slip / symlink post-extract gate. */
export function assertExtractContained(destDir: string): void {
  const root = realpathSync(destDir)
  const rootPrefix = root.endsWith(sep) ? root : root + sep
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) {
        throw new Error(`Archive extract rejected symlink: ${name}`)
      }
      const real = realpathSync(full)
      if (real !== root && !real.startsWith(rootPrefix)) {
        throw new Error(`Archive extract escaped destination: ${name}`)
      }
      if (st.isDirectory()) walk(full)
    }
  }
  walk(destDir)
}

/** Normalize a tar-listed entry name: backslashes and leading `./` are packaging variance. */
function normalizeArchiveEntryName(entry: string): string {
  return entry.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
}

/**
 * @internal Exported for unit tests — archive entry pre-scan gate. Rejects
 * `..` path segments and true-absolute names (leading `/`, UNC `\\`, drive
 * letter) before tar runs: bsdtar refuses `..` entries itself, but GNU tar
 * (Linux) extracts them outside destDir where assertExtractContained cannot
 * see them. Absolute entries are rejected fail-closed even though tar
 * sanitizes them; an entry that is empty after normalization is malformed.
 */
export function assertArchiveEntryNameContained(entry: string): void {
  const name = normalizeArchiveEntryName(entry)
  if (!name || name.split('/').includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Archive extract rejected escaping entry: ${entry}`)
  }
}

/**
 * Pre-scan an archive's entry list with `tar -tf` and reject any entry that
 * would extract outside destDir, BEFORE extraction (the zip-vs-tgz flag
 * mirrors the extract branching in extractArchive). One bounded, one-shot
 * subprocess per archive. assertExtractContained remains the post-extract
 * backstop (symlinks, realpath escapes inside destDir).
 */
async function assertArchiveEntriesContained(archivePath: string): Promise<void> {
  const ext = extname(archivePath).toLowerCase()
  const { stdout } = await execFileAsync(
    'tar',
    ext === '.zip' ? ['-tf', archivePath] : ['-tzf', archivePath]
  )
  for (const line of stdout.split(/\r?\n/)) {
    const entry = line.trim()
    if (!entry) continue
    assertArchiveEntryNameContained(entry)
  }
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await assertArchiveEntriesContained(archivePath)
  mkdirSync(destDir, { recursive: true })
  const ext = extname(archivePath).toLowerCase()
  // Prefer tar/libarchive for zip and tgz — the pre-scan above refuses `..`
  // entry paths up front (bsdtar also refuses them, but GNU tar on Linux
  // extracts them) and tar sanitizes absolute entries; the
  // assertExtractContained call below is the post-extract backstop.
  // Avoid Expand-Archive / unzip which do not enforce zip-slip containment.
  if (ext === '.zip') {
    await execFileAsync('tar', ['-xf', archivePath, '-C', destDir])
  } else {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir])
  }
  assertExtractContained(destDir)
}

function findPackageRoot(extractedDir: string): string {
  if (
    existsSync(join(extractedDir, 'vyotiq.mcp.json')) ||
    existsSync(join(extractedDir, 'vyotiq.plugin.json')) ||
    hasSkillPackageMarker(extractedDir)
  ) {
    return extractedDir
  }
  const kids = readdirSync(extractedDir, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const kid of kids) {
    const candidate = join(extractedDir, kid.name)
    if (
      existsSync(join(candidate, 'vyotiq.mcp.json')) ||
      existsSync(join(candidate, 'vyotiq.plugin.json')) ||
      hasSkillPackageMarker(candidate)
    ) {
      return candidate
    }
  }
  throw new Error('Extracted archive does not contain a Vyotiq package')
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  await downloadPublicUrlToFile(url, destPath)
}

export function copyPackageIntoStore(srcRoot: string, id: string, version: string): string {
  const dest = marketplacePackageDir(id, version)
  const srcResolved = resolve(srcRoot)
  const destResolved = resolve(dest)
  // Path installs can point at an already-installed package dir; deleting dest
  // first would destroy the source before cpSync.
  if (srcResolved === destResolved) {
    return dest
  }
  mkdirSync(dirname(dest), { recursive: true })
  const staging = join(dirname(dest), `.${basename(dest)}.staging-${randomBytes(8).toString('hex')}`)
  try {
    cpSync(srcRoot, staging, { recursive: true })
    commitStagedDirectory(staging, dest)
  } catch (err) {
    try {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
    } catch {
      // ignore staging cleanup
    }
    throw err
  }
  return dest
}

function commitStagedDirectory(staging: string, dest: string): void {
  const backup = existsSync(dest)
    ? join(dirname(dest), `.${basename(dest)}.bak-${randomBytes(8).toString('hex')}`)
    : null
  if (backup) renameSync(dest, backup)
  try {
    renameSync(staging, dest)
  } catch (err) {
    if (backup) {
      try {
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
        renameSync(backup, dest)
      } catch {
        // restore failed; original error is more useful
      }
    }
    throw err
  }
  if (backup) {
    rmSync(backup, { recursive: true, force: true })
  }
}

export function mcpServerFromManifest(root: string): McpServer {
  const manifest = VyotiqMcpManifestSchema.parse(
    JSON.parse(readFileSync(join(root, 'vyotiq.mcp.json'), 'utf8'))
  )
  return {
    id: manifest.id,
    name: manifest.name,
    transport: manifest.transport,
    command: manifest.command,
    args: manifest.args,
    env: sanitizeMcpManifestEnv(manifest.env),
    url: manifest.url,
    headers: manifest.headers,
    ...(manifest.allowedTools?.length ? { allowedTools: manifest.allowedTools } : {}),
    ...(manifest.deniedTools?.length ? { deniedTools: manifest.deniedTools } : {}),
    enabled: true,
    source: 'marketplace',
    packageId: manifest.id,
    packageVersion: manifest.version
  }
}

/** Sync marketplace-sourced MCP entries in settings.mcpServers from installed packages. */
export async function syncMarketplaceMcpIntoSettings(): Promise<void> {
  repairBundledMcpManifestsFromResources()
  repairBundledSkillPackagesFromResources()
  const index = readMarketplaceIndex()
  const settings = getSettings()
  const manual = (settings.mcpServers ?? []).filter((s) => s.source !== 'marketplace')
  const prevById = new Map(
    (settings.mcpServers ?? [])
      .filter((s) => s.source === 'marketplace')
      .map((s) => [s.id, s] as const)
  )
  const fromMarketplace: McpServer[] = []
  for (const item of index.items) {
    if (item.kind !== 'mcp') continue
    const root = resolveInstalledPackageRoot(item.packagePath)
    if (!existsSync(join(root, 'vyotiq.mcp.json'))) continue
    try {
      const server = mcpServerFromManifest(root)
      server.enabled = item.enabled
      // Preserve user-edited connection fields from settings (manifest = defaults).
      const prev = prevById.get(server.id)
      if (prev) {
        if (prev.allowedTools) server.allowedTools = prev.allowedTools
        if (prev.deniedTools) server.deniedTools = prev.deniedTools
        if (prev.transport) server.transport = prev.transport
        if (prev.command !== undefined) server.command = prev.command
        if (prev.args) server.args = prev.args
        if (prev.env) server.env = sanitizeMcpManifestEnv(prev.env)
        if (prev.url !== undefined) server.url = prev.url
        if (prev.headers) server.headers = prev.headers
        if (prev.oauthClientId) server.oauthClientId = prev.oauthClientId
        if (prev.authScope) server.authScope = prev.authScope
        if (prev.authWorkspacePath) server.authWorkspacePath = prev.authWorkspacePath
        if (prev.googleAccess) server.googleAccess = prev.googleAccess
      }
      // Repair known-broken uvx launch args (mcp SDK v2 rename) even when settings
      // still hold the pre-pin args from an older install.
      server.args = withCompatibleUvxArgs(server.command, server.args)
      // PYTHONIOENCODING is applied at spawn time in buildMcpChildEnv — do not
      // put it in settings.env (it was being stored as a fake "secret" every boot).
      if (prev?.env) {
        const cleaned = { ...(sanitizeMcpManifestEnv(prev.env) ?? {}) }
        delete cleaned.PYTHONIOENCODING
        server.env = Object.keys(cleaned).length > 0 ? cleaned : undefined
      }
      fromMarketplace.push(server)
    } catch (err) {
      logger.warn('Skip invalid marketplace MCP package', {
        scope: 'marketplace',
        id: item.id,
        err: formatError(err)
      })
    }
  }
  // Plugin-expanded MCP is handled in resolveEffectiveMcpServers.
  // Skip ack: untrusted sources are gated in installMarketplacePackage; bundled
  // sync must not fail assertMcpServersAcked (AppData: marketplace:install IPC).
  await enqueueSettingsMutation(() =>
    setSettings({ mcpServers: [...manual, ...fromMarketplace] }, { skipMcpAck: true })
  )
}

/**
 * Overwrite installed bundled skill SKILL.md from app resources when it drifts
 * (so create-skill instructions stay current after an app update).
 */
function repairBundledSkillPackagesFromResources(): void {
  const index = readMarketplaceIndex()
  for (const item of index.items) {
    if (item.kind !== 'skill' || item.installSource !== 'bundled') continue
    let destRoot: string
    try {
      destRoot = resolveInstalledPackageRoot(item.packagePath)
    } catch {
      continue
    }
    const bundledRoot = bundledPackagePath(item.id)
    for (const name of [SKILL_MD, LEGACY_SKILL_MD]) {
      const src = join(bundledRoot, name)
      const dest = join(destRoot, name)
      if (!existsSync(src)) continue
      try {
        mkdirSync(dirname(dest), { recursive: true })
        const next = readFileSync(src, 'utf8')
        const prev = existsSync(dest) ? readFileSync(dest, 'utf8') : ''
        if (next === prev) continue
        writeFileSync(dest, next, 'utf8')
        logger.info('Repaired bundled skill markdown from resources', {
          scope: 'marketplace',
          id: item.id,
          file: name
        })
      } catch (err) {
        logger.warn('Failed to repair bundled skill markdown', {
          scope: 'marketplace',
          id: item.id,
          file: name,
          err: formatError(err)
        })
      }
    }
  }
}

/**
 * Overwrite installed bundled MCP manifests from the app's resources when they
 * drift (e.g. after we ship uvx `--with mcp<2` pins for fetch/time).
 */
function repairBundledMcpManifestsFromResources(): void {
  const index = readMarketplaceIndex()
  for (const item of index.items) {
    if (item.kind !== 'mcp' || item.installSource !== 'bundled') continue
    const bundledRoot = bundledPackagePath(item.id)
    const src = join(bundledRoot, 'vyotiq.mcp.json')
    const dest = join(resolveInstalledPackageRoot(item.packagePath), 'vyotiq.mcp.json')
    if (!existsSync(src) || !existsSync(dest)) continue
    try {
      const next = readFileSync(src, 'utf8')
      const prev = readFileSync(dest, 'utf8')
      if (next === prev) continue
      writeFileSync(dest, next, 'utf8')
      logger.info('Repaired bundled MCP manifest from resources', {
        scope: 'marketplace',
        id: item.id
      })
    } catch (err) {
      logger.warn('Failed to repair bundled MCP manifest', {
        scope: 'marketplace',
        id: item.id,
        err: formatError(err)
      })
    }
  }
}

async function registerInstalled(
  detected: DetectedPackage,
  installSource: MarketplaceInstallSource,
  packageRelPath: string
): Promise<MarketplaceInstalledItem> {
  const prior = getInstalledItem(detected.id)
  const item: MarketplaceInstalledItem = {
    id: detected.id,
    kind: detected.kind,
    name: detected.name,
    version: detected.version,
    description: detected.description,
    // Preserve enablement across reinstall/upgrade of the same package id.
    enabled: prior?.enabled ?? true,
    installSource,
    installedAt: new Date().toISOString(),
    packagePath: packageRelPath
  }
  upsertInstalledItem(item)
  if (detected.kind === 'mcp') {
    await syncMarketplaceMcpIntoSettings()
  }
  return item
}

async function materializeToTemp(req: MarketplaceInstallRequest): Promise<{
  root: string
  cleanup: () => void
  source: MarketplaceInstallSource
}> {
  const source = req.source
  const target = req.target.trim()

  if (source === 'path') {
    if (!existsSync(target)) throw new Error(`Path not found: ${target}`)
    assertExtractContained(target)
    return { root: target, cleanup: () => {}, source }
  }

  if (source === 'bundled') {
    const path = bundledPackagePath(target)
    if (!existsSync(path)) throw new Error(`Bundled package not found: ${target}`)
    return { root: path, cleanup: () => {}, source }
  }

  if (source === 'remote') {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(target)
    } catch {
      throw new Error(`Invalid remote MCP URL: ${target}`)
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Remote MCP URL must be http or https')
    }
    const transport = req.transport ?? 'http'
    const id = remoteMcpIdFromUrl(target, req.name)
    const name = (req.name ?? '').trim() || parsedUrl.hostname || id
    // Bearer goes to OS secure storage after install — never write into the package.
    const headers = headersWithoutAuthorization(req.headers)
    const tmp = mkdtempSync(join(tmpdir(), 'vyotiq-mkt-remote-'))
    const cleanup = (): void => {
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
    const manifest = {
      schemaVersion: 1 as const,
      kind: 'mcp' as const,
      id,
      name,
      version: req.version?.trim() || '1.0.0',
      description: `Remote MCP (${transport}) at ${parsedUrl.origin}`,
      transport,
      url: target,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {})
    }
    writeFileSync(join(tmp, 'vyotiq.mcp.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return { root: tmp, cleanup, source }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'vyotiq-mkt-'))
  const cleanup = (): void => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }

  if (source === 'zip') {
    if (!existsSync(target)) {
      cleanup()
      throw new Error(`Zip not found: ${target}`)
    }
    const extractDir = join(tmp, 'extract')
    await extractArchive(target, extractDir)
    return { root: findPackageRoot(extractDir), cleanup, source }
  }

  if (source === 'git') {
    const cloneUrl = assertSafeGitCloneUrl(target)
    const cloneDir = join(tmp, 'repo')
    await execFileAsync(
      'git',
      ['-c', 'protocol.file.allow=never', 'clone', '--depth', '1', cloneUrl, cloneDir],
      {
        timeout: 120_000
      }
    )
    try {
      assertExtractContained(cloneDir)
    } catch (err) {
      cleanup()
      throw err
    }
    return { root: findPackageRoot(cloneDir), cleanup, source }
  }

  if (source === 'npm') {
    const packTarget = assertSafeNpmPackTarget(target)
    const packDir = join(tmp, 'npm')
    mkdirSync(packDir, { recursive: true })
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--ignore-scripts', '--pack-destination', packDir, '--', packTarget],
      {
        timeout: 120_000
      }
    )
    const tgzName = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
    if (!tgzName) {
      cleanup()
      throw new Error('npm pack produced no tarball')
    }
    const tgzPath = join(packDir, basename(tgzName))
    const extractDir = join(tmp, 'extract')
    await extractArchive(tgzPath, extractDir)
    return { root: findPackageRoot(extractDir), cleanup, source }
  }

  if (source === 'registry') {
    await refreshRemoteCatalog()
    const entries = await browseCatalog()
    const entry = entries.find((e) => e.id === target)
    if (!entry) {
      cleanup()
      throw new Error(`Package not found in catalog: ${target}`)
    }
    if (entry.source === 'bundled' && entry.bundledPath) {
      cleanup()
      return {
        root: bundledPackagePath(entry.bundledPath),
        cleanup: () => {},
        source: 'bundled'
      }
    }
    const registryUrl = (getSettings().marketplace?.registryUrl ?? '').trim().replace(/\/$/, '')
    const downloadUrl =
      entry.downloadUrl ??
      (() => {
        if (!registryUrl) return null
        const version = req.version ?? entry.version
        return `${registryUrl}/v1/packages/${encodeURIComponent(entry.id)}/versions/${encodeURIComponent(version)}/download`
      })()
    if (!downloadUrl) {
      cleanup()
      throw new Error('No download URL for catalog entry')
    }
    assertRegistryDownloadUrl(downloadUrl, registryUrl)
    const archivePath = join(tmp, 'pkg.zip')
    await downloadToFile(downloadUrl, archivePath)
    // Verify the archive digest before extraction when the catalog provides one.
    if (entry.sha256) {
      const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
      if (actual !== entry.sha256.toLowerCase()) {
        cleanup()
        throw new Error(
          `Archive sha256 mismatch for ${entry.id}: expected ${entry.sha256}, got ${actual}`
        )
      }
    }
    const extractDir = join(tmp, 'extract')
    try {
      await extractArchive(archivePath, extractDir)
    } catch (err) {
      if (isContainmentOrSymlinkError(err)) throw err
      // try as tarball
      const tgzPath = join(tmp, 'pkg.tgz')
      renameSync(archivePath, tgzPath)
      await extractArchive(tgzPath, extractDir)
    }
    return { root: findPackageRoot(extractDir), cleanup, source }
  }

  cleanup()
  throw new Error(`Unsupported install source: ${source}`)
}

export async function installMarketplacePackage(
  raw: unknown
): Promise<MarketplaceInstallResult> {
  const req = MarketplaceInstallRequestSchema.parse(raw)
  const settings = getSettings()
  // Untrusted sources (including local path folders) require the registry ack.
  const ackRequiredSources = new Set(['registry', 'git', 'npm', 'zip', 'remote', 'path'])
  if (ackRequiredSources.has(req.source) && !settings.marketplace?.remoteInstallAcked) {
    throw new Error(
      'Acknowledge marketplace install risk in Marketplace → Manage (Package Registry) before installing from registry, git, npm, zip, path, or remote MCP URLs.'
    )
  }
  const { root, cleanup, source } = await materializeToTemp(req)
  try {
    let detected: DetectedPackage
    try {
      detected = detectPackageAt(root)
    } catch (err) {
      if (source === 'git' || source === 'npm' || source === 'zip' || source === 'path') {
        if (synthesizeVyotiqMcpManifest(root)) {
          detected = detectPackageAt(root)
        } else {
          throw err
        }
      } else {
        throw err
      }
    }
    if (req.kind && req.kind !== detected.kind) {
      throw new Error(`Expected kind ${req.kind} but package is ${detected.kind}`)
    }
    if (detected.kind === 'mcp') {
      const collision = (settings.mcpServers ?? []).find(
        (s) => s.id === detected.id && s.source !== 'marketplace'
      )
      if (collision) {
        throw new Error(
          `MCP id "${detected.id}" already exists as a configured server. Remove it in Marketplace → Manage first.`
        )
      }
      // Reject remote URL installs that would overwrite a different remote package id collision.
      const prior = getInstalledItem(detected.id)
      if (prior && prior.kind === 'mcp' && req.source === 'remote') {
        const priorRoot = resolveInstalledPackageRoot(prior.packagePath)
        const priorManifest = join(priorRoot, 'vyotiq.mcp.json')
        if (existsSync(priorManifest)) {
          try {
            const prev = VyotiqMcpManifestSchema.parse(
              JSON.parse(readFileSync(priorManifest, 'utf8'))
            )
            if (prev.url && prev.url.trim() !== req.target.trim()) {
              throw new Error(
                `MCP id "${detected.id}" is already used by a different remote URL. Uninstall it first or choose a different name.`
              )
            }
          } catch (err) {
            if (err instanceof Error && err.message.includes('already used')) throw err
            // ignore unreadable prior manifest
          }
        }
      }
    }
    const dest = copyPackageIntoStore(detected.root, detected.id, detected.version)
    const rel = join(detected.id, detected.version).replace(/\\/g, '/')
    const item = await registerInstalled(detected, source, rel)
    let authTokenStored: boolean | undefined
    if (req.source === 'remote' && req.bearerToken?.trim()) {
      try {
        setMcpAuthToken(detected.id, req.bearerToken.trim())
        authTokenStored = true
      } catch (err) {
        authTokenStored = false
        logger.warn('Remote MCP installed but auth token could not be stored securely', {
          scope: 'marketplace',
          id: detected.id,
          err: formatError(err)
        })
      }
    }
    logger.info('Marketplace package installed', {
      scope: 'marketplace',
      id: item.id,
      kind: item.kind,
      source
    })
    void dest
    return authTokenStored === undefined ? { item } : { item, authTokenStored }
  } finally {
    cleanup()
  }
}
