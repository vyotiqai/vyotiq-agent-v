import { existsSync, realpathSync, statSync } from 'fs'
import { dirname, relative } from 'path'
import {
  MAX_EXTRA_ROOTS,
  dedupeExtraRoots,
  extraRootFor,
  extraRootKey,
  extraRootLabel,
  isAbsolutePathLike,
  isPathInsideRoot,
  slashPath
} from '../../shared/extraRoots'
import { canonicalizeWorkspacePath } from '../../shared/utils/workspacePath'
import { realpathIfExists, resolveInsideWorkspace } from '../workspace/safePath'
import { userDataRoot } from '../storage/paths'
import { wrapPromptSection } from './promptSections'

/**
 * Added folders ("extra roots") on the main side: which folders a task may
 * add, which root a tool path belongs to, and what the model is told.
 *
 * The one rule every caller relies on: a RELATIVE path always means the
 * primary workspace. An added folder is reached only by an absolute path
 * inside it, and that path is then resolved against the added folder with the
 * same symlink-escape check the workspace gets (`resolveInsideWorkspace`).
 */

export type ExtraRootRefusal = { path: string; reason: string }
export type ExtraRootsValidation = { roots: string[]; refused: ExtraRootRefusal[] }

/** Electron's userData, or null outside the app. */
function safeUserDataDir(): string | null {
  try {
    const dir = userDataRoot()
    return typeof dir === 'string' && dir ? dir : null
  } catch {
    return null
  }
}

/** A task worktree or an instance worktree: the only app-data folders a task may add. */
function isWorktreeInUserData(real: string, userData: string): boolean {
  const rel = slashPath(relative(userData, real))
  const segments = rel.split('/').filter(Boolean)
  return segments[0] === 'task-worktrees' || segments.includes('instance-worktrees')
}

/**
 * Check folders a task asks to add. Kept: absolute, existing folders that are
 * not the workspace or inside it, not a whole drive, not in (or around) the
 * app's data folder unless a worktree, and not overlapping one already kept —
 * at most {@link MAX_EXTRA_ROOTS}. Each kept folder is its real path, so a
 * symlinked spelling and its target are one folder.
 */
export function validateExtraRoots(
  primaryRoot: string,
  candidates: readonly string[] | undefined,
  opts: { userDataDir?: string | null } = {}
): ExtraRootsValidation {
  const roots: string[] = []
  const refused: ExtraRootRefusal[] = []
  const userDataDir = opts.userDataDir !== undefined ? opts.userDataDir : safeUserDataDir()
  const userData = userDataDir ? realpathIfExists(userDataDir) : null
  const primary = primaryRoot ? realpathIfExists(primaryRoot) : ''

  // Uncapped here: a folder past the limit is refused with a reason, never dropped silently.
  for (const raw of dedupeExtraRoots(candidates ? [...candidates] : [], Number.POSITIVE_INFINITY)) {
    const refuse = (reason: string): void => {
      refused.push({ path: raw, reason })
    }
    if (raw.includes('\0') || !isAbsolutePathLike(raw)) {
      refuse('not an absolute path')
      continue
    }
    const canonical = canonicalizeWorkspacePath(raw)
    if (!existsSync(canonical)) {
      refuse('does not exist')
      continue
    }
    let real: string
    try {
      if (!statSync(canonical).isDirectory()) {
        refuse('not a folder')
        continue
      }
      real = realpathSync(canonical)
    } catch {
      refuse('cannot be read')
      continue
    }
    if (dirname(real) === real) {
      refuse('a whole drive is too broad to add')
      continue
    }
    if (primary && isPathInsideRoot(real, primary)) {
      refuse('already part of the workspace')
      continue
    }
    if (userData && isPathInsideRoot(real, userData) && !isWorktreeInUserData(real, userData)) {
      refuse("in the app's data folder")
      continue
    }
    if (userData && isPathInsideRoot(userData, real)) {
      refuse("holds the app's data folder")
      continue
    }
    const overlap = roots.find((r) => isPathInsideRoot(real, r) || isPathInsideRoot(r, real))
    if (overlap) {
      refuse(`overlaps ${extraRootLabel(overlap)}`)
      continue
    }
    if (roots.length >= MAX_EXTRA_ROOTS) {
      refuse(`at most ${MAX_EXTRA_ROOTS} folders`)
      continue
    }
    roots.push(real)
  }
  return { roots, refused }
}

/**
 * The added folder an ABSOLUTE tool path belongs to, or null — null for a
 * relative path and for anything inside the primary workspace, which keeps
 * the workspace's own rules (path_scope, retired data, run artifacts).
 */
export function routeExtraRoot(
  primaryRoot: string,
  extraRoots: readonly string[] | undefined,
  pathArg: string
): string | null {
  if (!extraRoots?.length) return null
  const p = pathArg.trim()
  if (!p || !isAbsolutePathLike(p)) return null
  if (isPathInsideRoot(p, primaryRoot)) return null
  return extraRootFor(p, extraRoots)
}

/**
 * `resolveInsideWorkspace` across the workspace and its added folders: the
 * workspace first (relative paths only ever mean it), then the added folder
 * an absolute path names. Symlink escapes are refused per root. Throws the
 * workspace's own error when no root takes the path.
 */
export function resolveInsideRoots(
  primaryRoot: string,
  extraRoots: readonly string[] | undefined,
  pathArg: string
): string {
  try {
    return resolveInsideWorkspace(primaryRoot, pathArg)
  } catch (err) {
    const root = routeExtraRoot(primaryRoot, extraRoots, pathArg)
    if (!root) throw err
    return resolveInsideWorkspace(root, pathArg)
  }
}

const PATH_ARG_KEYS = ['path', 'file', 'filepath', 'filename'] as const

function pathArgOf(args: Record<string, unknown>, keys: readonly string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return { key, value: value.trim() }
  }
  return null
}

/** `pattern` with `root` taken off its front, or null when it does not start with the root. */
function stripRootPrefix(pattern: string, root: string): string | null {
  const p = slashPath(pattern.trim())
  const r = slashPath(root)
  const windows = /^[A-Za-z]:\//.test(r) || r.startsWith('//')
  const pk = windows ? p.toLowerCase() : p
  const rk = windows ? r.toLowerCase() : r
  if (pk === rk) return ''
  if (!pk.startsWith(`${rk}/`)) return null
  return p.slice(r.length + 1)
}

/** Tools that take one file or folder path and can run in an added folder. */
const SINGLE_PATH_TOOLS = new Set(['read', 'edit', 'str_replace', 'delete', 'list_dir', 'edit_notebook'])

/**
 * Where a tool call runs when it names an added folder: the folder, and the
 * args to run it with there. Null leaves the call on the workspace.
 *
 * - read / edit / str_replace / delete / edit_notebook keep their absolute
 *   path: the tools resolve it against the added folder, and the write
 *   checkpoint records it under that absolute path.
 * - list_dir gets the path relative to the folder (its gitignore matcher
 *   walks relative folders).
 * - glob's pattern and grep's include lose the folder prefix; the handler puts
 *   it back on every result, so the model can pass them straight to read.
 * - search keeps its absolute `path` (it resolves it against the folder, like
 *   read) and cites hits absolute.
 */
export function routeExtraRootToolCall(
  name: string,
  args: Record<string, unknown>,
  primaryRoot: string,
  extraRoots: readonly string[] | undefined
): { root: string; args: Record<string, unknown> } | null {
  if (!extraRoots?.length) return null
  if (SINGLE_PATH_TOOLS.has(name)) {
    const keys = name === 'edit_notebook' ? ['target_notebook', ...PATH_ARG_KEYS] : PATH_ARG_KEYS
    const arg = pathArgOf(args, keys)
    if (!arg) return null
    const root = routeExtraRoot(primaryRoot, extraRoots, arg.value)
    if (!root) return null
    if (name !== 'list_dir') return { root, args }
    const rel = stripRootPrefix(arg.value, root)
    return { root, args: { ...args, [arg.key]: rel ? rel : '.' } }
  }
  if (name === 'search') {
    const arg = pathArgOf(args, ['path'])
    const root = arg ? routeExtraRoot(primaryRoot, extraRoots, arg.value) : null
    return root ? { root, args } : null
  }
  if (name === 'glob' || name === 'grep') {
    const key = name === 'glob' ? 'pattern' : 'include'
    const value = typeof args[key] === 'string' ? (args[key] as string).trim() : ''
    if (!value || !isAbsolutePathLike(value)) return null
    for (const root of extraRoots) {
      const rest = stripRootPrefix(value, root)
      if (rest === null) continue
      if (name === 'glob') return { root, args: { ...args, pattern: rest || '**/*' } }
      const next = { ...args }
      if (rest) next.include = rest
      else delete next.include
      return { root, args: next }
    }
    return null
  }
  return null
}

/** A character that can continue a path segment: a root followed by one is a different folder. */
const PATH_NAME_CHAR = /[A-Za-z0-9._~$@+-]/

/** True when `text` names `rootForm` as a whole path (not a longer sibling like `backend2`). */
function mentionsPath(text: string, rootForm: string): boolean {
  if (!rootForm) return false
  let at = text.indexOf(rootForm)
  while (at !== -1) {
    const next = text[at + rootForm.length]
    if (next === undefined || !PATH_NAME_CHAR.test(next)) return true
    at = text.indexOf(rootForm, at + 1)
  }
  return false
}

/**
 * The added folders a terminal command could write in, for the opaque-command
 * snapshot (workspaceMutationWatch.ts): the one its working directory is in,
 * and any whose absolute path the command spells out — in either slash form,
 * and as Git Bash's `/c/…` for a drive path. Each snapshot costs a `git
 * status` or a walk, so folders the command never names are left out. A
 * command that reaches a folder only through `..` from elsewhere is not seen.
 */
export function extraRootsForCommand(command: string, cwd: string, extraRoots: readonly string[] | undefined): string[] {
  if (!extraRoots?.length) return []
  const text = command.replace(/\\/g, '/')
  const folded = text.toLowerCase()
  return extraRoots.filter((root) => {
    if (cwd && isPathInsideRoot(cwd, root)) return true
    const key = extraRootKey(root)
    const drive = /^([a-z]):\/(.*)$/.exec(key)
    if (drive) return mentionsPath(folded, key) || mentionsPath(folded, `/${drive[1]}/${drive[2]}`)
    if (key.startsWith('//')) return mentionsPath(folded, key.toLowerCase())
    return mentionsPath(text, key)
  })
}

/**
 * The run's added folders as they stand now: re-checked at every invoke, so a
 * folder deleted or moved since the task started simply drops out.
 */
export function liveExtraRoots(primaryRoot: string, persisted: readonly string[] | undefined): string[] {
  if (!persisted?.length) return []
  return validateExtraRoots(primaryRoot, persisted).roots
}

/**
 * What the model is told about the added folders. Per task, so it rides in
 * the volatile system zone beside the session block — never the byte-stable
 * prefix.
 */
export function formatExtraRootsSection(extraRoots: readonly string[]): string {
  if (extraRoots.length === 0) return ''
  const lines = [
    'This task may also read and edit these folders, outside the workspace:',
    ...extraRoots.map((root) => `- ${root}`),
    '',
    'Relative paths still mean the workspace. Reach an added folder by an absolute path inside it:',
    '- read, edit, str_replace, delete, list_dir and edit_notebook take that path directly.',
    '- glob: start the pattern with the folder (e.g. `<folder>/src/**/*.ts`); grep: start include with it; search: pass the folder (or a subfolder) as path. Results come back as absolute paths.',
    '- terminal: pass the folder (or a subfolder) as working_directory.',
    'codebase_search, concept_search, lsp, git tools and memory cover the workspace only. Edits in an added folder are checkpointed and undoable like workspace edits; they are not part of the workspace git repository.'
  ]
  return wrapPromptSection('added_folders', lines.join('\n'))
}
