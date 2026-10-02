/**
 * What a sandboxed agent command may touch, as a list of path rules.
 *
 * Pure apart from the injected fs probes, so the rules for a representative
 * machine (a worktree, paths with spaces, a missing cache) are unit-testable
 * on any OS. Only macOS and Linux reach this: paths are POSIX throughout.
 */
import { posix } from 'path'
import type { AgentSandboxNetwork } from '../../../shared/ipc'

/**
 * `write`: read and write everything under the path.
 * `read-only`: readable, never writable — even inside a `write` path.
 * `hidden`: neither readable nor writable (bwrap mounts an empty tmpfs over it).
 */
export type SandboxRuleKind = 'write' | 'read-only' | 'hidden'

export type SandboxRule = { kind: SandboxRuleKind; path: string }

export type SandboxPolicy = {
  rules: SandboxRule[]
  network: AgentSandboxNetwork
  /** Canonical working directory the command starts in. */
  cwd: string
}

export type SandboxFs = {
  exists: (path: string) => boolean
  /** Canonical path (symlinks resolved); may throw for a missing path. */
  realpath: (path: string) => string
  isFile: (path: string) => boolean
  /** File text, or null when unreadable. */
  readText: (path: string) => string | null
}

export type ResolveSandboxPolicyInput = {
  platform: 'darwin' | 'linux'
  /** The workspace the command runs in — a task worktree when there is one. */
  workspaceRoots: readonly string[]
  cwd: string
  homeDir: string
  tmpDir: string
  /** The app's own data (settings, sessions, logs). Hidden from commands. */
  userDataDir: string | null
  network: AgentSandboxNetwork
  fs: SandboxFs
}

/**
 * Package-manager caches a build or install writes to, relative to $HOME.
 * Only the ones that already exist become writable: bwrap cannot bind a
 * missing path, and a cache the user never created is not one a command needs.
 */
const SHARED_CACHE_DIRS = [
  '.npm',
  '.pnpm-store',
  '.yarn/berry/cache',
  '.bun/install/cache',
  '.cargo/registry',
  '.cargo/git',
  'go/pkg/mod',
  '.gradle/caches',
  '.m2/repository'
]

const PLATFORM_CACHE_DIRS: Record<ResolveSandboxPolicyInput['platform'], readonly string[]> = {
  darwin: [
    'Library/pnpm',
    'Library/Caches/pnpm',
    'Library/Caches/Yarn',
    'Library/Caches/pip',
    'Library/Caches/go-build',
    'Library/Caches/node-gyp',
    '.cache/uv'
  ],
  linux: [
    '.local/share/pnpm',
    '.cache/pnpm',
    '.cache/yarn',
    '.cache/pip',
    '.cache/go-build',
    '.cache/node-gyp',
    '.cache/uv'
  ]
}

/** Secrets under $HOME no command needs to read. */
const HIDDEN_HOME_DIRS = ['.ssh']

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/**
 * The git directories a workspace's own `git` writes to. A linked worktree's
 * `.git` is a file pointing into the main checkout's `.git/worktrees/<name>`,
 * and commits land in the shared object store, so both must be writable or
 * `git commit` fails inside the sandbox.
 */
export function gitDirsFor(
  root: string,
  fs: SandboxFs
): { gitDir: string; commonDir: string } | null {
  const dotGit = posix.join(root, '.git')
  if (!fs.exists(dotGit)) return null
  if (!fs.isFile(dotGit)) return { gitDir: dotGit, commonDir: dotGit }
  const text = fs.readText(dotGit)
  const match = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null
  if (!match?.[1]) return null
  const gitDir = posix.resolve(root, match[1])
  const common = fs.readText(posix.join(gitDir, 'commondir'))?.trim()
  const commonDir = common ? posix.resolve(gitDir, common) : gitDir
  return { gitDir, commonDir }
}

/**
 * Build the rule list. Writable: the workspace, its git dirs, temp, and the
 * package caches that exist. Read-only inside those: git hooks and config,
 * since either can make the user's own (unsandboxed) git run code later.
 * Hidden: the app's data dir and ~/.ssh.
 */
export function resolveSandboxPolicy(input: ResolveSandboxPolicyInput): SandboxPolicy {
  const { fs } = input
  const canon = (path: string): string => {
    try {
      return trimSlash(fs.realpath(path))
    } catch {
      return trimSlash(path)
    }
  }
  const rules: SandboxRule[] = []
  const add = (kind: SandboxRuleKind, path: string, mustExist = true): void => {
    if (!path || (mustExist && !fs.exists(path))) return
    const canonical = canon(path)
    if (rules.some((r) => r.kind === kind && r.path === canonical)) return
    rules.push({ kind, path: canonical })
  }

  for (const root of input.workspaceRoots) {
    add('write', root, false)
    const git = gitDirsFor(canon(root), fs)
    if (git) {
      add('write', git.commonDir)
      if (git.gitDir !== git.commonDir) add('write', git.gitDir)
      add('read-only', posix.join(git.commonDir, 'hooks'))
      add('read-only', posix.join(git.commonDir, 'config'))
    }
  }

  const tmp = canon(input.tmpDir)
  add('write', tmp, false)
  if (input.platform === 'darwin') {
    add('write', '/private/tmp')
    add('write', '/private/var/tmp')
    // $TMPDIR is /var/folders/xx/yy/T; its sibling C is the per-user cache
    // dir (DARWIN_USER_CACHE_DIR) compilers write module caches to.
    if (posix.basename(tmp) === 'T') add('write', posix.join(posix.dirname(tmp), 'C'))
  } else {
    add('write', '/tmp')
    add('write', '/var/tmp')
  }

  for (const rel of [...SHARED_CACHE_DIRS, ...PLATFORM_CACHE_DIRS[input.platform]]) {
    add('write', posix.join(input.homeDir, rel))
  }

  if (input.userDataDir) add('hidden', input.userDataDir)
  for (const rel of HIDDEN_HOME_DIRS) add('hidden', posix.join(input.homeDir, rel))

  return { rules, network: input.network, cwd: canon(input.cwd) }
}

function depth(path: string): number {
  return path === '/' ? 0 : path.split('/').filter(Boolean).length
}

const KIND_ORDER: Record<SandboxRuleKind, number> = { write: 0, 'read-only': 1, hidden: 2 }

/**
 * Rules from the most general path to the most specific. Both backends let a
 * later rule override an earlier one, so ordering by depth makes the deepest
 * path win: a worktree inside the hidden app-data dir is still writable, and
 * ~/.ssh stays hidden when the workspace is $HOME. On the same path the
 * stricter kind wins.
 */
export function orderedRules(policy: SandboxPolicy): SandboxRule[] {
  return policy.rules
    .map((rule, index) => ({ rule, index }))
    .sort(
      (a, b) =>
        depth(a.rule.path) - depth(b.rule.path) ||
        KIND_ORDER[a.rule.kind] - KIND_ORDER[b.rule.kind] ||
        a.index - b.index
    )
    .map(({ rule }) => rule)
}
