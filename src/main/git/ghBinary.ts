import { execFile as execFileCb, spawn, spawnSync } from 'child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync
} from 'fs'
import { join, dirname } from 'path'
import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { app } from 'electron'
import { commandOnPath, invalidateCommandOnPathCache, sanitizedTerminalEnv } from '../agent/tools/terminal'
import { atomicWriteJson } from '../storage/atomicWrite'
import { logger } from '../../shared/logger'

const execFile = promisify(execFileCb)

const GH_PROBE_TTL_MS = 60_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const POST_INSTALL_WAIT_MS = 120_000
const POST_INSTALL_POLL_MS = 2_000

export type GithubCliInstallResult = {
  installed: boolean
  detail: string
  ghAvailable: boolean
}

type GhCliRecord = {
  version: 1
  executable: string
}

let cachedGhPath: string | null = null
let ghProbeCache: { ok: boolean; checkedAt: number } | null = null

function ghEnv(): NodeJS.ProcessEnv {
  return {
    ...sanitizedTerminalEnv(),
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never'
  }
}

function ghInstallDir(): string | null {
  try {
    if (!app?.getPath) return null
    return join(app.getPath('userData'), 'bin')
  } catch {
    return null
  }
}

function bundledGhPath(): string | null {
  const dir = ghInstallDir()
  if (!dir) return null
  const ext = process.platform === 'win32' ? '.exe' : ''
  return join(dir, `gh${ext}`)
}

function ghCliRecordPath(): string | null {
  try {
    if (!app?.getPath) return null
    return join(app.getPath('userData'), 'gh-cli.json')
  } catch {
    return null
  }
}

function readPersistedGhPath(): string | null {
  const recordPath = ghCliRecordPath()
  if (!recordPath || !existsSync(recordPath)) return null
  try {
    const raw = JSON.parse(readFileSync(recordPath, 'utf8')) as Partial<GhCliRecord>
    if (raw.version !== 1 || typeof raw.executable !== 'string') return null
    const executable = raw.executable.trim()
    return executable || null
  } catch {
    return null
  }
}

function persistGhPath(executable: string): void {
  const recordPath = ghCliRecordPath()
  if (!recordPath) return
  try {
    atomicWriteJson(recordPath, { version: 1, executable } satisfies GhCliRecord, 0o600)
  } catch (err) {
    logger.warn('Failed to persist GitHub CLI path', { scope: 'gh-install', err })
  }
}

function clearPersistedGhPath(): void {
  const recordPath = ghCliRecordPath()
  if (!recordPath || !existsSync(recordPath)) return
  try {
    unlinkSync(recordPath)
  } catch {
    /* ignore */
  }
}

function ghDiscoveryPathPrefixes(): string[] {
  const prefixes: string[] = []
  const bundled = bundledGhPath()
  if (bundled) prefixes.push(dirname(bundled))

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      prefixes.push(join(localAppData, 'Microsoft', 'WinGet', 'Links'))
      prefixes.push(join(localAppData, 'Programs', 'GitHub CLI'))
    }
    const programFiles = process.env.ProgramFiles
    if (programFiles) prefixes.push(join(programFiles, 'GitHub CLI'))
  } else if (process.platform === 'darwin') {
    prefixes.push('/opt/homebrew/bin', '/usr/local/bin')
  } else {
    prefixes.push('/usr/bin', '/usr/local/bin')
    const home = process.env.HOME
    if (home) prefixes.push(join(home, '.local', 'bin'))
  }

  const seen = new Set<string>()
  return prefixes.filter((entry) => {
    const key = process.platform === 'win32' ? entry.toLowerCase() : entry
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function augmentPathForGhDiscovery(): NodeJS.ProcessEnv {
  const env = sanitizedTerminalEnv()
  const sep = process.platform === 'win32' ? ';' : ':'
  const extras = ghDiscoveryPathPrefixes()
  env.PATH = [...extras, env.PATH ?? process.env.PATH ?? ''].filter(Boolean).join(sep)
  return env
}

function resolveGhFromPath(env: NodeJS.ProcessEnv = augmentPathForGhDiscovery()): string | null {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(finder, ['gh'], {
    encoding: 'utf8',
    windowsHide: true,
    env
  })
  if (result.status !== 0 || !result.stdout?.trim()) return null
  const line = result.stdout.trim().split(/\r?\n/)[0]?.trim()
  if (!line) return null
  return existsSync(line) ? line : null
}

function winGetGhPaths(): string[] {
  if (process.platform !== 'win32') return []
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return []

  const paths = [join(localAppData, 'Microsoft', 'WinGet', 'Links', 'gh.exe')]
  const packagesDir = join(localAppData, 'Microsoft', 'WinGet', 'Packages')
  if (!existsSync(packagesDir)) return paths

  try {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith('github.cli')) continue
      paths.push(join(packagesDir, entry.name, 'bin', 'gh.exe'))
    }
  } catch {
    /* ignore unreadable package dir */
  }
  return paths
}

/** Known install locations when PATH has not refreshed yet. */
export function knownGhPaths(): string[] {
  const paths: string[] = []
  const bundled = bundledGhPath()
  if (bundled) paths.push(bundled)

  if (process.platform === 'win32') {
    paths.push(...winGetGhPaths())
    const localAppData = process.env.LOCALAPPDATA
    const programFiles = process.env.ProgramFiles
    if (localAppData) paths.push(join(localAppData, 'Programs', 'GitHub CLI', 'gh.exe'))
    if (programFiles) paths.push(join(programFiles, 'GitHub CLI', 'gh.exe'))
    const pf86 = process.env['ProgramFiles(x86)']
    if (pf86) paths.push(join(pf86, 'GitHub CLI', 'gh.exe'))
  } else if (process.platform === 'darwin') {
    paths.push('/opt/homebrew/bin/gh', '/usr/local/bin/gh')
  } else {
    paths.push('/usr/bin/gh', '/usr/local/bin/gh')
    const home = process.env.HOME
    if (home) paths.push(join(home, '.local', 'bin', 'gh'))
  }

  const seen = new Set<string>()
  return paths.filter((candidate) => {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key)) return false
    seen.add(key)
    return existsSync(candidate)
  })
}

export function invalidateGhBinaryCache(): void {
  cachedGhPath = null
  ghProbeCache = null
}

/** @internal */
export function resetGhBinaryCacheForTests(): void {
  invalidateGhBinaryCache()
}

async function verifyGhExecutable(executable: string): Promise<boolean> {
  try {
    await execFile(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: ghEnv()
    })
    return true
  } catch {
    return false
  }
}

/** Scan known locations and PATH (with WinGet/Homebrew prefixes) and persist the first working gh. */
export async function discoverGhExecutable(): Promise<string | null> {
  if (cachedGhPath && (await verifyGhExecutable(cachedGhPath))) {
    return cachedGhPath
  }

  const persisted = readPersistedGhPath()
  if (persisted && existsSync(persisted) && (await verifyGhExecutable(persisted))) {
    cachedGhPath = persisted
    return persisted
  }
  if (persisted) clearPersistedGhPath()

  for (const candidate of knownGhPaths()) {
    if (await verifyGhExecutable(candidate)) {
      cachedGhPath = candidate
      persistGhPath(candidate)
      return candidate
    }
  }

  invalidateCommandOnPathCache('gh')
  for (const env of [augmentPathForGhDiscovery(), sanitizedTerminalEnv()]) {
    const fromPath = resolveGhFromPath(env)
    if (!fromPath || !(await verifyGhExecutable(fromPath))) continue
    cachedGhPath = fromPath
    persistGhPath(fromPath)
    return fromPath
  }

  cachedGhPath = null
  return null
}

export async function resolveGhExecutable(): Promise<string | null> {
  if (cachedGhPath) return cachedGhPath
  return discoverGhExecutable()
}

export async function ghAvailable(): Promise<boolean> {
  const now = Date.now()
  if (ghProbeCache && now - ghProbeCache.checkedAt < GH_PROBE_TTL_MS) {
    return ghProbeCache.ok
  }
  const executable = await discoverGhExecutable()
  const ok = Boolean(executable)
  ghProbeCache = { ok, checkedAt: now }
  return ok
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForGhAfterInstall(): Promise<string | null> {
  const deadline = Date.now() + POST_INSTALL_WAIT_MS
  while (Date.now() < deadline) {
    invalidateGhBinaryCache()
    invalidateCommandOnPathCache('gh')
    const executable = await discoverGhExecutable()
    if (executable) return executable
    await sleep(POST_INSTALL_POLL_MS)
  }
  return null
}

function installLooksSuccessful(output: string): boolean {
  const text = output.toLowerCase()
  return (
    text.includes('successfully installed') ||
    text.includes('already installed') ||
    text.includes('no applicable update found') ||
    text.includes('nothing to do')
  )
}

async function runCommand(
  bin: string,
  args: string[],
  timeout = INSTALL_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: ghEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${bin} timed out after ${Math.round(timeout / 1000)}s`))
    }, timeout)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const combined = `${stdout}\n${stderr}`.trim()
      if (code === 0 || installLooksSuccessful(combined)) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(combined || `${bin} exited with code ${code ?? 'unknown'}`))
    })
  })
}

async function installWithWinget(): Promise<string> {
  await runCommand('winget', [
    'install',
    '--id',
    'GitHub.cli',
    '-e',
    '--source',
    'winget',
    '--scope',
    'user',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity'
  ])
  return 'GitHub CLI installed with winget.'
}

async function installWithBrew(): Promise<string> {
  await runCommand('brew', ['install', 'gh'])
  return 'GitHub CLI installed with Homebrew.'
}

function ghReleaseArch(): string {
  switch (process.arch) {
    case 'arm64':
      return 'arm64'
    case 'x64':
    case 'ia32':
      return 'amd64'
    default:
      return 'amd64'
  }
}

function ghReleaseOs(): 'windows' | 'macOS' | 'linux' {
  switch (process.platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'macOS'
    case 'linux':
      return 'linux'
    default:
      return 'linux'
  }
}

type GhReleaseAsset = {
  name: string
  browser_download_url: string
}

async function fetchLatestGhAsset(): Promise<GhReleaseAsset> {
  const res = await fetch('https://api.github.com/repos/cli/cli/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vyotiq-agent-v' }
  })
  if (!res.ok) {
    throw new Error(`Failed to resolve GitHub CLI release (HTTP ${res.status})`)
  }
  const json = (await res.json()) as {
    tag_name?: string
    assets?: Array<{ name?: string; browser_download_url?: string }>
  }
  const tag = json.tag_name?.replace(/^v/, '')
  if (!tag) throw new Error('GitHub CLI release metadata is missing a version tag')

  const os = ghReleaseOs()
  const arch = ghReleaseArch()
  const ext = os === 'linux' ? 'tar.gz' : 'zip'
  const expected = `gh_${tag}_${os}_${arch}.${ext}`
  const asset = (json.assets ?? []).find((entry) => entry.name === expected)
  if (!asset?.browser_download_url || !asset.name) {
    throw new Error(`GitHub CLI release asset not found (${expected})`)
  }
  return { name: asset.name, browser_download_url: asset.browser_download_url }
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'vyotiq-agent-v' } })
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download GitHub CLI (HTTP ${res.status})`)
  }
  mkdirSync(dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  await pipeline(res.body as never, createWriteStream(partial))
  renameSync(partial, dest)
}

function findGhBinary(root: string): string | null {
  const entries = readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = findGhBinary(full)
      if (nested) return nested
      continue
    }
    if (entry.name === 'gh' || entry.name === 'gh.exe') return full
  }
  return null
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const command = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
      await runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', command])
      return
    }
    await runCommand('unzip', ['-o', archivePath, '-d', destDir])
    return
  }
  await runCommand('tar', ['-xzf', archivePath, '-C', destDir])
}

async function installFromRelease(): Promise<string> {
  const asset = await fetchLatestGhAsset()
  const installDir = ghInstallDir()
  if (!installDir) throw new Error('Vyotiq app data path is unavailable')
  const archivePath = join(installDir, asset.name)
  const extractDir = join(installDir, 'extract')
  mkdirSync(installDir, { recursive: true })
  await downloadToFile(asset.browser_download_url, archivePath)
  await extractArchive(archivePath, extractDir)
  const discovered = findGhBinary(extractDir)
  if (!discovered) {
    throw new Error('Downloaded GitHub CLI archive did not contain gh')
  }
  const target = bundledGhPath()
  if (!target) throw new Error('Vyotiq app data path is unavailable')
  renameSync(discovered, target)
  if (process.platform !== 'win32') {
    chmodSync(target, 0o755)
  }
  try {
    unlinkSync(archivePath)
  } catch {
    /* ignore */
  }
  cachedGhPath = target
  persistGhPath(target)
  return 'GitHub CLI downloaded into Vyotiq.'
}

async function installGithubCliForPlatform(): Promise<string> {
  if (process.platform === 'win32') {
    if (commandOnPath('winget')) {
      try {
        return await installWithWinget()
      } catch (err) {
        logger.warn('winget GitHub CLI install failed; falling back to direct download', {
          scope: 'gh-install',
          err
        })
      }
    }
    return installFromRelease()
  }

  if (process.platform === 'darwin') {
    if (commandOnPath('brew')) {
      try {
        return await installWithBrew()
      } catch (err) {
        logger.warn('brew GitHub CLI install failed; falling back to direct download', {
          scope: 'gh-install',
          err
        })
      }
    }
    return installFromRelease()
  }

  if (commandOnPath('brew')) {
    try {
      return await installWithBrew()
    } catch (err) {
      logger.warn('brew GitHub CLI install failed; falling back to direct download', {
        scope: 'gh-install',
        err
      })
    }
  }
  return installFromRelease()
}

/** Install GitHub CLI using the native package manager when possible. */
export async function installGithubCli(): Promise<GithubCliInstallResult> {
  const existing = await discoverGhExecutable()
  if (existing) {
    return {
      installed: true,
      detail: 'GitHub CLI is already available.',
      ghAvailable: true
    }
  }

  let detail = await installGithubCliForPlatform()
  let executable = await waitForGhAfterInstall()
  if (!executable) {
    try {
      const fallbackDetail = await installFromRelease()
      detail = `${detail} ${fallbackDetail}`.trim()
      invalidateGhBinaryCache()
      invalidateCommandOnPathCache('gh')
      executable = await discoverGhExecutable()
    } catch (err) {
      logger.warn('GitHub CLI direct-download fallback failed', { scope: 'gh-install', err })
    }
  }

  if (!executable) {
    throw new Error(
      `${detail} GitHub CLI finished installing but Vyotiq could not activate it. Click Install GitHub CLI again.`
    )
  }

  ghProbeCache = { ok: true, checkedAt: Date.now() }
  return {
    installed: true,
    detail,
    ghAvailable: true
  }
}
