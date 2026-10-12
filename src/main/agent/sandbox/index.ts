/**
 * The one entry point the agent's command paths call: settings + this
 * machine → off, a ready SandboxLaunch, or a refusal to show the agent.
 *
 * Asked-for-but-unavailable is a refusal, never a silent unsandboxed run.
 * The terminal panel a person types into never comes through here.
 */
import { app } from 'electron'
import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { homedir, tmpdir } from 'os'
import type { AgentSandboxSettings } from '../../../shared/ipc'
import { getSandboxCapability, type DetectedSandbox } from './capability'
import { resolveSandboxPolicy, type SandboxFs } from './policy'
import { describeSandbox, wrapSandboxedCommand, type SandboxLaunch } from './wrap'
import { lowIntegrityArgv, lowIntegrityTempDir, resolveWindowsSandboxPolicy, windowsLabelPlan } from './windows'
import { applyWindowsLabels, restoreWindowsLabels, writeSandboxScript } from './windowsSetup'

export type { SandboxLaunch } from './wrap'
export { sandboxDenialHint } from './wrap'
export { getSandboxCapability } from './capability'

export type AgentSandbox =
  | { state: 'off' }
  | { state: 'unavailable'; message: string }
  | { state: 'on'; launch: SandboxLaunch }

const nodeFs: SandboxFs = {
  exists: existsSync,
  realpath: (path) => realpathSync(path),
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }
}

function electronUserData(): string | null {
  try {
    return app?.getPath?.('userData') ?? null
  } catch {
    return null
  }
}

export type PrepareAgentSandboxDeps = {
  capability?: DetectedSandbox
  platform?: NodeJS.Platform
  fs?: SandboxFs
  homeDir?: string
  tmpDir?: string
  userDataDir?: string | null
  /** %LOCALAPPDATA% (Windows caches). */
  localAppData?: string | null
}

/** Windows: low integrity cannot block the network, so Deny is refused, not ignored. */
export const WINDOWS_NETWORK_DENY_REASON =
  'Network: Deny is not available on Windows: the low-integrity sandbox confines file writes, not the network. Set Network to Allow in Settings → Tools → Sandbox.'

/**
 * Agent-built tools run in an Electron utility process: Electron starts it,
 * so there is no command line to put sandbox-exec or bwrap in front of.
 */
export const AGENT_BUILT_TOOL_SANDBOX_REFUSAL = [
  'Not run: agent-built tools cannot run inside the command sandbox.',
  'They run as an Electron utility process, which the OS sandbox cannot wrap, and nothing runs unconfined while the sandbox is on.',
  'Do the same work with the terminal tool instead, or ask the user to turn the sandbox off in Settings → Tools → Sandbox.'
].join('\n')

/** The refusal the agent reads when the sandbox is on but cannot run here. */
export function sandboxUnavailableMessage(reason: string | null): string {
  return [
    'Sandbox unavailable: this command was not run.',
    reason ?? 'This machine cannot sandbox commands.',
    'Commands are not run unsandboxed while the sandbox is on. Ask the user to fix the above or turn the sandbox off in Settings → Tools → Sandbox.'
  ].join('\n')
}

export function prepareAgentSandbox(
  input: {
    workspace: string
    cwd?: string
    /** The task's added folders (extraRoots.ts): writable like the workspace. */
    extraRoots?: readonly string[]
    settings: AgentSandboxSettings | undefined
  },
  deps: PrepareAgentSandboxDeps = {}
): AgentSandbox {
  const settings = input.settings
  if (!settings || settings.mode === 'off') return { state: 'off' }
  const capability = deps.capability ?? getSandboxCapability()
  const platform = deps.platform ?? process.platform
  if (!capability.available || !capability.mechanism) {
    return { state: 'unavailable', message: sandboxUnavailableMessage(capability.reason) }
  }
  if (platform === 'win32' && capability.mechanism === 'low-integrity' && capability.shells) {
    if (settings.network === 'deny') {
      return { state: 'unavailable', message: sandboxUnavailableMessage(WINDOWS_NETWORK_DENY_REASON) }
    }
    const homeDir = deps.homeDir ?? homedir()
    const userDataDir = deps.userDataDir !== undefined ? deps.userDataDir : electronUserData()
    if (!userDataDir) {
      return { state: 'unavailable', message: sandboxUnavailableMessage('The app data folder is unknown.') }
    }
    const policy = resolveWindowsSandboxPolicy({
      workspaceRoots: [input.workspace, ...(input.extraRoots ?? [])],
      cwd: input.cwd ?? input.workspace,
      homeDir,
      localAppData: deps.localAppData !== undefined ? deps.localAppData : (process.env.LOCALAPPDATA ?? null),
      userDataDir,
      network: settings.network,
      fs: deps.fs ?? nodeFs
    })
    const shells = capability.shells
    const tempDir = lowIntegrityTempDir(homeDir)
    return {
      state: 'on',
      launch: {
        label: describeSandbox('low-integrity', settings.network),
        network: settings.network,
        wrap: (bin, args) =>
          lowIntegrityArgv(shells, tempDir, bin, args, {
            writeScript: (extension, text) => writeSandboxScript(homeDir, extension, text)
          }),
        ready: () => applyWindowsLabels(userDataDir, homeDir, windowsLabelPlan(policy))
      }
    }
  }
  const mechanism = capability.mechanism
  if (mechanism === 'low-integrity' || (platform !== 'darwin' && platform !== 'linux')) {
    return { state: 'unavailable', message: sandboxUnavailableMessage(capability.reason) }
  }
  const policy = resolveSandboxPolicy({
    platform,
    workspaceRoots: [input.workspace, ...(input.extraRoots ?? [])],
    cwd: input.cwd ?? input.workspace,
    homeDir: deps.homeDir ?? homedir(),
    tmpDir: deps.tmpDir ?? tmpdir(),
    userDataDir: deps.userDataDir !== undefined ? deps.userDataDir : electronUserData(),
    network: settings.network,
    fs: deps.fs ?? nodeFs
  })
  const executable = capability.executable ?? undefined
  return {
    state: 'on',
    launch: {
      label: describeSandbox(mechanism, settings.network),
      network: settings.network,
      wrap: (bin, args) => wrapSandboxedCommand(mechanism, policy, bin, args, executable)
    }
  }
}

/**
 * prepareAgentSandbox, then whatever the sandbox must finish before its first
 * command (Windows labels the folders commands may write). A failure there
 * refuses the command rather than running it unconfined.
 */
export async function prepareAgentSandboxReady(
  input: Parameters<typeof prepareAgentSandbox>[0],
  deps: PrepareAgentSandboxDeps = {}
): Promise<AgentSandbox> {
  const sandbox = prepareAgentSandbox(input, deps)
  if (sandbox.state !== 'on' || !sandbox.launch.ready) return sandbox
  try {
    await sandbox.launch.ready()
    return sandbox
  } catch (err) {
    return { state: 'unavailable', message: sandboxUnavailableMessage(err instanceof Error ? err.message : String(err)) }
  }
}

/**
 * Turning the sandbox off on Windows puts back the labels it set, so the
 * workspace and caches are as they were. Elsewhere there is nothing to undo.
 */
/** `under`: only what the sandbox labelled at or inside that folder (a workspace being removed). */
export function undoAgentSandboxSetup(under?: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  const userDataDir = electronUserData()
  return userDataDir ? restoreWindowsLabels(userDataDir, undefined, under) : Promise.resolve()
}
