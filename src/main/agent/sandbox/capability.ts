/**
 * Can this machine sandbox a command, and with what. Every probe is injected
 * so the answer for each platform is unit-testable on any one of them.
 */
import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import type { SandboxCapability } from '../../../shared/ipc'
import { SANDBOX_EXEC_PATH, type SandboxMechanism } from './wrap'

export type DetectedSandbox = SandboxCapability & {
  /** sandbox-exec or the bwrap binary; null when unavailable. */
  executable: string | null
}

export type SandboxCapabilityDeps = {
  platform: NodeJS.Platform
  exists: (path: string) => boolean
  /** PATH as the app sees it, for finding bwrap. */
  pathEnv: string
  /** Run a no-op inside the mechanism; ok false carries its first error line. */
  probe: (mechanism: SandboxMechanism, executable: string) => { ok: boolean; detail: string }
}

/**
 * Windows is unavailable on purpose. Confining one process's writes there
 * needs an AppContainer or a restricted token plus ACL edits, all native
 * calls this app has no dependency for; `runas /trustlevel` drops admin
 * rights but confines neither writes nor network, and cannot pipe stdio.
 * Saying "sandboxed" over any of those would be a lie.
 */
export const WINDOWS_UNAVAILABLE_REASON =
  'Windows has no built-in way to confine one command’s file writes and network without extra system components, so the sandbox runs on macOS and Linux only.'

export const BWRAP_MISSING_REASON =
  'bubblewrap (bwrap) is not installed. Install it with your package manager (for example `sudo apt install bubblewrap`), then reopen this page.'

const BWRAP_FALLBACK_PATHS = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap']

function findBwrap(deps: SandboxCapabilityDeps): string | null {
  for (const dir of deps.pathEnv.split(':')) {
    if (!dir) continue
    const candidate = `${dir.replace(/\/+$/, '')}/bwrap`
    if (deps.exists(candidate)) return candidate
  }
  return BWRAP_FALLBACK_PATHS.find((path) => deps.exists(path)) ?? null
}

function unavailable(reason: string): DetectedSandbox {
  return { available: false, mechanism: null, reason, executable: null }
}

export function detectSandboxCapability(deps: SandboxCapabilityDeps): DetectedSandbox {
  if (deps.platform === 'win32') return unavailable(WINDOWS_UNAVAILABLE_REASON)
  if (deps.platform === 'darwin') {
    if (!deps.exists(SANDBOX_EXEC_PATH)) {
      return unavailable(`${SANDBOX_EXEC_PATH} is missing, so commands cannot be confined on this Mac.`)
    }
    const probe = deps.probe('seatbelt', SANDBOX_EXEC_PATH)
    if (!probe.ok) {
      return unavailable(`sandbox-exec could not start a sandbox here${probe.detail ? `: ${probe.detail}` : '.'}`)
    }
    return { available: true, mechanism: 'seatbelt', reason: null, executable: SANDBOX_EXEC_PATH }
  }
  if (deps.platform === 'linux') {
    const bwrap = findBwrap(deps)
    if (!bwrap) return unavailable(BWRAP_MISSING_REASON)
    const probe = deps.probe('bubblewrap', bwrap)
    if (!probe.ok) {
      return unavailable(
        `bwrap is installed but could not start a sandbox${probe.detail ? ` (${probe.detail})` : ''}. Unprivileged user namespaces may be turned off on this system.`
      )
    }
    return { available: true, mechanism: 'bubblewrap', reason: null, executable: bwrap }
  }
  return unavailable(`There is no command sandbox for ${deps.platform}.`)
}

/** Start the mechanism around `true`: proves it works here, not just that it is installed. */
function defaultProbe(mechanism: SandboxMechanism, executable: string): { ok: boolean; detail: string } {
  const args =
    mechanism === 'seatbelt'
      ? ['-p', '(version 1)(allow default)', '--', '/usr/bin/true']
      : ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent', '--', 'true']
  try {
    const res = spawnSync(executable, args, { encoding: 'utf8', timeout: 5_000, windowsHide: true })
    if (res.error) return { ok: false, detail: res.error.message }
    const detail = (res.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''
    return { ok: res.status === 0, detail }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

export function defaultSandboxCapabilityDeps(): SandboxCapabilityDeps {
  return {
    platform: process.platform,
    exists: existsSync,
    pathEnv: process.env.PATH ?? process.env.Path ?? '',
    probe: defaultProbe
  }
}

let cached: DetectedSandbox | null = null

/**
 * Detected once and kept: the probe spawns. `refresh` re-detects — Settings
 * asks with it, so installing bwrap and reopening the page is enough.
 */
export function getSandboxCapability(opts: { refresh?: boolean } = {}): DetectedSandbox {
  if (!cached || opts.refresh) cached = detectSandboxCapability(defaultSandboxCapabilityDeps())
  return cached
}

export function resetSandboxCapabilityCacheForTests(next: DetectedSandbox | null = null): void {
  cached = next
}
