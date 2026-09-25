import { loadStatus } from '../state'
import { isSafeWorkspaceRelPath } from '../../../shared/utils/workspacePath'

const BINARY_EXTENSIONS = [
  '.gguf',
  '.bin',
  '.zip',
  '.tar',
  '.gz',
  '.safetensors',
  '.pt',
  '.onnx',
  '.pth',
  '.ckpt'
] as const

export function isBinaryWritePath(path: string): boolean {
  const lower = path.toLowerCase().replace(/\\/g, '/')
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Enforced at tool execution — not a pre-dispatch gate. */
export function assertWritablePath(path: string): void {
  if (isBinaryWritePath(path)) {
    throw new Error(
      `Refusing to write text contents to binary path ${path}. ` +
        'Use the terminal tool to download binaries (e.g. huggingface-cli download, curl -L -o).'
    )
  }
}

function normalizeScopePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/** True when a path_scope prefix is a safe workspace-relative path (after slash normalize). */
export function isSafePathScopePrefix(path: string): boolean {
  const scope = normalizeScopePath(path.trim())
  return Boolean(scope) && isSafeWorkspaceRelPath(scope)
}

/** True when relPath equals a scope prefix or is nested under it (no `..` escapes). */
export function isRelPathInPathScope(relPath: string, pathScope: string[]): boolean {
  const norm = normalizeScopePath(relPath)
  if (!norm || !isSafeWorkspaceRelPath(norm)) return false
  return pathScope.some((raw) => {
    if (!isSafePathScopePrefix(raw)) return false
    const scope = normalizeScopePath(raw)
    // Windows path matching is case-insensitive, mirroring
    // parallelMutationPathKey (classify.ts) and mutationQueue.pathKey — a
    // `src/` scope must also cover `SRC/`. POSIX behavior is unchanged.
    const relKey = process.platform === 'win32' ? norm.toLowerCase() : norm
    const scopeKey = process.platform === 'win32' ? scope.toLowerCase() : scope
    return relKey === scopeKey || relKey.startsWith(`${scopeKey}/`)
  })
}

/**
 * Retired per-profile data root — `.vyotiq/agents/<id>/` holds legacy user
 * data left on disk after the profiles feature was removed.
 */
const RETIRED_AGENT_DATA_PREFIX = '.vyotiq/agents/'

/**
 * Deny a run reaching into the retired `.vyotiq/agents/` data root.
 *
 * `.vyotiq` is in `IGNORED_DIRS`, so glob/grep/search and `list_dir` skip these
 * files — but `read` resolves its path with `resolveInsideWorkspace` alone and
 * has no deny list, so a direct path reaches this legacy data. The feature is
 * gone: nothing in a run has business under `.vyotiq/agents/`, reading or
 * writing. The user is not restricted — this guard is about run access only.
 */
export function assertNotRetiredAgentDataPath(relPaths: readonly string[]): void {
  for (const rel of relPaths) {
    const norm = normalizeScopePath(rel.trim())
    if (!norm) continue
    const key = process.platform === 'win32' ? norm.toLowerCase() : norm
    if (!key.startsWith(RETIRED_AGENT_DATA_PREFIX)) continue
    throw new Error(
      `Path "${rel.trim()}" is retired per-profile data (.vyotiq/agents/). ` +
        'This denial will not change on retry — that directory is legacy user data outside run access.'
    )
  }
}

type InlineInstanceGuardOpts = {
  /** When false, skip disk — caller already knows this is not an inline instance. */
  inlineInstance?: boolean
}

function loadInlineInstanceStatus(
  runDir: string | undefined,
  opts?: InlineInstanceGuardOpts
): ReturnType<typeof loadStatus> | undefined {
  if (!runDir) return undefined
  if (opts?.inlineInstance === false) return undefined
  const status = loadStatus(runDir)
  if (!status?.inlineInstance) return undefined
  return status
}

/**
 * Deny workspace writes outside an inline instance's path_scope when set.
 * Call for product-file writers (edit / str_replace / delete) and git_commit paths.
 */
export function assertInlineInstancePathScope(
  runDir: string | undefined,
  relPaths: string[],
  opts?: InlineInstanceGuardOpts
): void {
  if (!runDir || relPaths.length === 0) return
  const status = loadInlineInstanceStatus(runDir, opts)
  if (!status) return
  const scope = status.pathScope
  if (!scope?.length) return
  for (const rel of relPaths) {
    const trimmed = rel.trim()
    if (!trimmed) continue
    if (!isRelPathInPathScope(trimmed, scope)) {
      throw new Error(
        `Path "${trimmed}" is outside this instance path_scope (${scope.join(', ')}).`
      )
    }
  }
}

/**
 * Shared path_scope instances (no worktree) cannot use tools that escape the
 * parent tree (terminal, diagnostics, git_commit, MCP). Worktree instances keep them.
 */
export function assertInlineInstanceUnscopedToolAllowed(
  runDir: string | undefined,
  toolLabel: string,
  opts?: InlineInstanceGuardOpts
): void {
  const status = loadInlineInstanceStatus(runDir, opts)
  if (!status) return
  if (!status.pathScope?.length) return
  if (status.worktreePath) return
  throw new Error(
    `${toolLabel} is denied for path_scope-shared inline instances without a worktree. ` +
      'Use edit/str_replace within path_scope, or run in a git repo so the instance gets an isolated worktree. ' +
      'This denial will not change on retry — do not repeat this call; finish within path_scope or conclude as blocked.'
  )
}

export function assertInlineInstanceTerminalAllowed(
  runDir: string | undefined,
  opts?: InlineInstanceGuardOpts
): void {
  assertInlineInstanceUnscopedToolAllowed(runDir, 'terminal', opts)
}

/** Inline instances merge back via merge_agent_instance — never push the instance branch. */
export function assertInlineInstancePushDenied(
  runDir: string | undefined,
  opts?: InlineInstanceGuardOpts
): void {
  const status = loadInlineInstanceStatus(runDir, opts)
  if (!status) return
  throw new Error(
    'Inline instances cannot push. Pin merge_agent_instance on the parent after the instance finishes.'
  )
}
