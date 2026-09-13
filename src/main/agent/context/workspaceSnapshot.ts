import { execFile as execFileCallback, execFileSync } from 'child_process'
import { promisify } from 'util'
import { existsSync, readdirSync, statSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { namedGitBranch } from '../../../shared/utils/gitBranch'
import { sanitizedTerminalEnv } from '../tools/terminal'
import { HARNESS_SECTION_TAGS } from '../harnessSections'
import { neutralizeXmlTags, wrapPromptSection } from '../promptSections'

const execFile = promisify(execFileCallback)

const MAX_ENTRIES = 40
const CACHE_TTL_MS = 30_000
const GOAL_TOKEN = '{{GOAL}}'

/** Tags a post-wrap goal fill must not be able to close. */
const WORKSPACE_GOAL_TAGS = ['workspace', 'live_session', ...HARNESS_SECTION_TAGS] as const

function fillWorkspaceGoal(template: string, goal: string): string {
  return template.replace(GOAL_TOKEN, neutralizeXmlTags(goal, WORKSPACE_GOAL_TAGS))
}

const GIT_STATUS_TIMEOUT_MS = 3000
const GIT_BRANCH_TIMEOUT_MS = 2000
const GIT_MAX_BUFFER = 64 * 1024

const MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml']

type SnapshotCacheEntry = {
  fingerprint: string
  template: string
  builtAt: number
}

const snapshotCache = new Map<string, SnapshotCacheEntry>()
const templateBuildInflight = new Map<string, Promise<string>>()

export function clearWorkspaceSnapshotCache(workspacePath?: string): void {
  if (workspacePath) {
    snapshotCache.delete(workspacePath)
    for (const key of templateBuildInflight.keys()) {
      if (key.startsWith(`${workspacePath}|`)) templateBuildInflight.delete(key)
    }
    return
  }
  snapshotCache.clear()
  templateBuildInflight.clear()
}

export function buildWorkspaceSnapshot(workspacePath: string | null, goal: string): string {
  if (!workspacePath) {
    return wrapPromptSection('workspace', ['No workspace selected.', `Goal: ${goal}`].join('\n'))
  }

  const fingerprint = workspaceFingerprint(workspacePath)
  const cached = snapshotCache.get(workspacePath)
  const fresh =
    cached &&
    cached.fingerprint === fingerprint &&
    Date.now() - cached.builtAt < CACHE_TTL_MS

  if (fresh) {
    return fillWorkspaceGoal(cached.template, goal)
  }

  const template = buildWorkspaceSnapshotTemplateSync(workspacePath)
  snapshotCache.set(workspacePath, {
    fingerprint,
    template,
    builtAt: Date.now()
  })
  return fillWorkspaceGoal(template, goal)
}

export async function buildWorkspaceSnapshotAsync(
  workspacePath: string | null,
  goal: string
): Promise<string> {
  if (!workspacePath) {
    return wrapPromptSection('workspace', ['No workspace selected.', `Goal: ${goal}`].join('\n'))
  }

  const fingerprint = workspaceFingerprint(workspacePath)
  const cached = snapshotCache.get(workspacePath)
  const fresh =
    cached &&
    cached.fingerprint === fingerprint &&
    Date.now() - cached.builtAt < CACHE_TTL_MS

  if (fresh) {
    return fillWorkspaceGoal(cached.template, goal)
  }

  const inflightKey = `${workspacePath}|${fingerprint}`
  let inflight = templateBuildInflight.get(inflightKey)
  if (!inflight) {
    inflight = buildWorkspaceSnapshotTemplateAsync(workspacePath)
      .then((template) => {
        snapshotCache.set(workspacePath, {
          fingerprint,
          template,
          builtAt: Date.now()
        })
        return template
      })
      .finally(() => {
        templateBuildInflight.delete(inflightKey)
      })
    templateBuildInflight.set(inflightKey, inflight)
  }

  const template = await inflight
  return fillWorkspaceGoal(template, goal)
}

function buildWorkspaceSnapshotTemplateSync(workspacePath: string): string {
  const lines: string[] = [
    `Root: ${workspacePath}`,
    'Terminal cwd: workspace root (terminal paths are relative to this directory).',
    `Goal: ${GOAL_TOKEN}`
  ]

  const found = MANIFESTS.filter((name) => existsSync(join(workspacePath, name)))
  if (found.length) {
    lines.push('', `### Manifests`, found.map((n) => `- ${n}`).join('\n'))
  }

  try {
    const all = readdirSync(workspacePath)
    const entries = all
      .filter((name) => !name.startsWith('.') || name === '.vyotiq')
      .slice(0, MAX_ENTRIES)
      .map((name) => {
        try {
          const st = statSync(join(workspacePath, name))
          return `${st.isDirectory() ? 'dir' : 'file'}  ${name}`
        } catch {
          return `?  ${name}`
        }
      })
    lines.push('', '### Top-level')
    lines.push(...entries)
    if (all.length > MAX_ENTRIES) {
      lines.push('… (truncated)')
    }
  } catch {
    lines.push('(listing unavailable)')
  }

  const branch = gitBranchSync(workspacePath)
  if (branch) lines.push('', `Git branch: ${branch}`)

  const gitStatus = gitStatusShortSync(workspacePath)
  if (gitStatus) lines.push('', '### Git status (short)', gitStatus)

  return wrapPromptSection('workspace', lines.join('\n'))
}

async function buildWorkspaceSnapshotTemplateAsync(workspacePath: string): Promise<string> {
  const lines: string[] = [
    `Root: ${workspacePath}`,
    'Terminal cwd: workspace root (terminal paths are relative to this directory).',
    `Goal: ${GOAL_TOKEN}`
  ]

  const found = MANIFESTS.filter((name) => existsSync(join(workspacePath, name)))
  if (found.length) {
    lines.push('', `### Manifests`, found.map((n) => `- ${n}`).join('\n'))
  }

  try {
    const all = await readdir(workspacePath)
    const entries = await Promise.all(
      all
        .filter((name) => !name.startsWith('.') || name === '.vyotiq')
        .slice(0, MAX_ENTRIES)
        .map(async (name) => {
          try {
            const st = await stat(join(workspacePath, name))
            return `${st.isDirectory() ? 'dir' : 'file'}  ${name}`
          } catch {
            return `?  ${name}`
          }
        })
    )
    lines.push('', '### Top-level')
    lines.push(...entries)
    if (all.length > MAX_ENTRIES) {
      lines.push('… (truncated)')
    }
  } catch {
    lines.push('(listing unavailable)')
  }

  const [branch, gitStatus] = await Promise.all([
    gitBranchAsync(workspacePath),
    gitStatusShortAsync(workspacePath)
  ])
  if (branch) lines.push('', `Git branch: ${branch}`)
  if (gitStatus) lines.push('', '### Git status (short)', gitStatus)

  return wrapPromptSection('workspace', lines.join('\n'))
}

function workspaceFingerprint(workspacePath: string): string {
  const parts: string[] = []
  try {
    parts.push(`root:${statSync(workspacePath).mtimeMs}`)
  } catch {
    return ''
  }
  for (const name of MANIFESTS) {
    const p = join(workspacePath, name)
    if (existsSync(p)) {
      try {
        parts.push(`${name}:${statSync(p).mtimeMs}`)
      } catch {
        parts.push(`${name}:?`)
      }
    }
  }
  const gitHead = join(workspacePath, '.git', 'HEAD')
  if (existsSync(gitHead)) {
    try {
      parts.push(`git:${statSync(gitHead).mtimeMs}`)
    } catch {
      parts.push('git:?')
    }
  }
  // Index mtime moves on staged/working-tree changes that HEAD alone misses.
  const gitIndex = join(workspacePath, '.git', 'index')
  if (existsSync(gitIndex)) {
    try {
      parts.push(`git-index:${statSync(gitIndex).mtimeMs}`)
    } catch {
      parts.push('git-index:?')
    }
  }
  return parts.join('|')
}

const GIT_ENV = {
  ...sanitizedTerminalEnv(),
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GCM_INTERACTIVE: 'never'
}

async function runGit(args: string[], cwd: string, timeout: number): Promise<string> {
  const { stdout } = await execFile('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    env: GIT_ENV
  })
  return stdout
}

async function gitStatusShortAsync(cwd: string): Promise<string | null> {
  try {
    if (!existsSync(join(cwd, '.git'))) return null
    const out = await runGit(['status', '--short'], cwd, GIT_STATUS_TIMEOUT_MS)
    const lines = out.trim().split('\n').filter(Boolean).slice(0, 15)
    if (!lines.length) return '(clean)'
    const suffix = out.trim().split('\n').length > 15 ? '\n… (truncated)' : ''
    return lines.join('\n') + suffix
  } catch {
    return null
  }
}

async function gitBranchAsync(cwd: string): Promise<string | null> {
  try {
    if (!existsSync(join(cwd, '.git'))) return null
    const out = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, GIT_BRANCH_TIMEOUT_MS)
    return namedGitBranch(out)
  } catch {
    return null
  }
}

function gitStatusShortSync(cwd: string): string | null {
  try {
    if (!existsSync(join(cwd, '.git'))) return null
    const out = execFileSync('git', ['status', '--short'], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_STATUS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const lines = out.trim().split('\n').filter(Boolean).slice(0, 15)
    if (!lines.length) return '(clean)'
    const suffix = out.trim().split('\n').length > 15 ? '\n… (truncated)' : ''
    return lines.join('\n') + suffix
  } catch {
    return null
  }
}

function gitBranchSync(cwd: string): string | null {
  try {
    if (!existsSync(join(cwd, '.git'))) return null
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_BRANCH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return namedGitBranch(out)
  } catch {
    return null
  }
}
