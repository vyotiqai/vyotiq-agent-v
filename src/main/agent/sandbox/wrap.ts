/**
 * Turn a SandboxPolicy into the argv that runs a command inside it:
 * `sandbox-exec -p <SBPL> -D PATH_n=… -- bin …` on macOS, `bwrap … -- bin …`
 * on Linux. Pure — no fs, no spawn — so every profile is asserted in tests.
 */
import type { AgentSandboxNetwork } from '../../../shared/ipc'
import { orderedRules, type SandboxPolicy } from './policy'

export type SandboxMechanism = 'seatbelt' | 'bubblewrap'

export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec'

export type WrappedCommand = { bin: string; args: string[] }

/**
 * A ready sandbox for one command: what the spawn site needs and nothing
 * else, so terminal.ts and diagnostics.ts never see the policy or the OS.
 */
export type SandboxLaunch = {
  /** One line for the tool result: `workspace-write via bubblewrap, network denied`. */
  label: string
  network: AgentSandboxNetwork
  wrap: (bin: string, args: string[]) => WrappedCommand
}

/** A string literal for SBPL. Paths go in as `-D` params; this is for fixed text. */
function sbplString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The Seatbelt profile plus the `-D` params its rules read. Paths travel as
 * params rather than spliced into the profile, so a path with spaces, quotes
 * or parentheses cannot change the profile's meaning.
 *
 * The shape is Bazel's darwin sandbox: allow by default, then deny every
 * write and allow back the writable roots. Seatbelt lets a later rule
 * override an earlier one, which is also what orders the path rules.
 */
export function buildSeatbeltProfile(policy: SandboxPolicy): { profile: string; params: string[] } {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    // Device nodes: /dev/null, /dev/tty, /dev/fd/*. The rest need root anyway.
    `(allow file-write* (subpath ${sbplString('/dev')}))`
  ]
  const params: string[] = []
  orderedRules(policy).forEach((rule, index) => {
    const name = `PATH_${index}`
    params.push(`${name}=${rule.path}`)
    const path = `(subpath (param ${sbplString(name)}))`
    if (rule.kind === 'write') {
      lines.push(`(allow file-read* file-write* ${path})`)
    } else if (rule.kind === 'read-only') {
      lines.push(`(allow file-read* ${path})`, `(deny file-write* ${path})`)
    } else {
      lines.push(`(deny file-read* file-write* ${path})`)
    }
  })
  if (policy.network === 'deny') {
    lines.push(
      '(deny network*)',
      // Local dev servers and test fixtures keep working; the internet does not.
      `(allow network* (local ip ${sbplString('localhost:*')}))`,
      `(allow network* (remote ip ${sbplString('localhost:*')}))`,
      '(allow network* (remote unix-socket))'
    )
  }
  return { profile: lines.join('\n'), params }
}

export function seatbeltArgv(policy: SandboxPolicy, bin: string, args: readonly string[]): WrappedCommand {
  const { profile, params } = buildSeatbeltProfile(policy)
  return {
    bin: SANDBOX_EXEC_PATH,
    args: ['-p', profile, ...params.flatMap((param) => ['-D', param]), '--', bin, ...args]
  }
}

/**
 * bubblewrap argv. The root is bound read-only, then each rule is mounted in
 * depth order so the deeper mount lands on top. `--unshare-pid` is what lets
 * an unprivileged bwrap mount a fresh /proc; `--new-session` stops a command
 * pushing keystrokes into a terminal it does not own.
 */
export function bwrapArgv(
  policy: SandboxPolicy,
  bin: string,
  args: readonly string[],
  bwrapPath = 'bwrap'
): WrappedCommand {
  const out = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc']
  for (const rule of orderedRules(policy)) {
    if (rule.kind === 'write') out.push('--bind', rule.path, rule.path)
    else if (rule.kind === 'read-only') out.push('--ro-bind', rule.path, rule.path)
    else out.push('--tmpfs', rule.path)
  }
  out.push('--unshare-pid')
  if (policy.network === 'deny') out.push('--unshare-net')
  out.push('--die-with-parent', '--new-session', '--chdir', policy.cwd, '--', bin, ...args)
  return { bin: bwrapPath, args: out }
}

export function wrapSandboxedCommand(
  mechanism: SandboxMechanism,
  policy: SandboxPolicy,
  bin: string,
  args: readonly string[],
  executable?: string
): WrappedCommand {
  return mechanism === 'seatbelt'
    ? seatbeltArgv(policy, bin, args)
    : bwrapArgv(policy, bin, args, executable ?? 'bwrap')
}

export function describeSandbox(mechanism: SandboxMechanism, network: AgentSandboxNetwork): string {
  return `workspace-write via ${mechanism}, network ${network === 'deny' ? 'denied' : 'allowed'}`
}

/** Writes outside the writable roots: EPERM from Seatbelt, EROFS from bwrap's read-only root. */
const WRITE_DENIAL_RE =
  /Operation not permitted|\bEPERM\b|Read-only file system|\bEROFS\b|sandbox-exec:|\bdeny\(\d+\)/i
/** What a command sees with no network: no route, or no DNS. */
const NETWORK_DENIAL_RE =
  /Network is unreachable|\bENETUNREACH\b|Could not resolve host|Temporary failure in name resolution|\bEAI_AGAIN\b|getaddrinfo ENOTFOUND|Name or service not known/i

/**
 * One line naming the sandbox when a failed command's output looks like a
 * denial, so the agent stops retrying a command the OS will keep refusing.
 * Null when nothing in the output points at the sandbox.
 */
export function sandboxDenialHint(output: string, network: AgentSandboxNetwork): string | null {
  const write = WRITE_DENIAL_RE.test(output)
  const net = network === 'deny' && NETWORK_DENIAL_RE.test(output)
  if (!write && !net) return null
  const what = write && net
    ? 'a write outside the workspace or a network connection'
    : write
      ? 'a write outside the workspace'
      : 'a network connection'
  return `[sandbox] The OS sandbox likely blocked ${what}: agent commands may write only to the workspace, temp and package caches${network === 'deny' ? ', with no network' : ''}. Do not retry the same command; work inside the workspace, or ask the user to turn the sandbox off (Settings → Tools → Sandbox).`
}

/** The `sandbox:` line a run_tests / diagnostics result carries under `command:`. */
export function sandboxHeaderLines(sandbox: Pick<SandboxLaunch, 'label'> | undefined): string[] {
  return sandbox ? [`sandbox: ${sandbox.label}`] : []
}

/** The denial hint as trailing lines of a failed result; empty when it does not apply. */
export function sandboxHintLines(
  output: string,
  sandbox: Pick<SandboxLaunch, 'network'> | undefined
): string[] {
  const hint = sandbox ? sandboxDenialHint(output, sandbox.network) : null
  return hint ? ['', hint] : []
}
