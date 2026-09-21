import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'fs'
import { readFile } from 'fs/promises'
import { dirname, join, relative, resolve, basename } from 'path'
import { canonicalizeWorkspacePath } from '../../../shared/utils/workspacePath'
import { isInsideRoot } from '../../workspace/safePath'
import { MEMORY_INDEX_CAP, MEMORY_STATE_CAP } from './types'

/**
 * Memory namespaces: a run bound to an agent profile keeps its durable memory
 * under `.vyotiq/agents/<profileId>/memory/` instead of the shared
 * `.vyotiq/memory/`, so teammates never cross-contaminate their knowledge.
 * The namespace MUST be a filesystem-safe slug (it becomes a path segment).
 */
export function assertSafeMemoryNamespace(namespace: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(namespace)) {
    throw new Error('Invalid memory namespace')
  }
  return namespace
}

function memoryDir(workspacePath: string, namespace?: string): string {
  return namespace
    ? join(workspacePath, '.vyotiq', 'agents', namespace, 'memory')
    : join(workspacePath, '.vyotiq', 'memory')
}

export function memoryRoot(workspacePath: string, namespace?: string): string {
  if (namespace) assertSafeMemoryNamespace(namespace)
  return memoryDir(workspacePath, namespace)
}

function workspaceRealRoot(workspacePath: string): string {
  const root = canonicalizeWorkspacePath(workspacePath)
  return existsSync(root) ? realpathSync(root) : root
}

/** Memory root must resolve inside the workspace (blocks junction/symlink escape). */
function assertMemoryRootInsideWorkspace(workspacePath: string, namespace?: string): string {
  const wsReal = workspaceRealRoot(workspacePath)
  const planned = memoryDir(wsReal, namespace)
  // Walk up to the nearest EXISTING ancestor and resolve from there — the
  // memory dir itself usually doesn't exist yet, and a symlinked `.vyotiq`
  // (or `agents/`) ancestor must still be resolved before first write.
  const tail: string[] = []
  let probe = planned
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    tail.unshift(basename(probe))
    probe = parent
  }
  const realBase = existsSync(probe) ? realpathSync(probe) : probe
  const realRoot = tail.length > 0 ? join(realBase, ...tail) : realBase
  if (!isInsideRoot(realRoot, wsReal)) {
    throw new Error('Memory directory escapes workspace')
  }
  return realRoot
}

export function ensureMemoryLayout(workspacePath: string, namespace?: string): void {
  assertMemoryRootInsideWorkspace(workspacePath, namespace)
  const root = memoryRoot(workspacePath, namespace)
  const notes = join(root, 'notes')
  if (!existsSync(notes)) mkdirSync(notes, { recursive: true })
  const indexPath = join(root, 'index.md')
  if (!existsSync(indexPath)) {
    writeFileSync(
      indexPath,
      '# Memory index\n\nShort pointers to durable notes. Keep this file brief.\n',
      'utf8'
    )
  }
}

/**
 * True once this namespace has been written to. The memory panel shows an
 * empty state rather than inventing a layout for a teammate that has never run.
 */
export function memoryNamespaceExists(workspacePath: string, namespace?: string): boolean {
  return existsSync(memoryRoot(workspacePath, namespace))
}

/**
 * Delete a namespace's memory directory. Returns false when there was nothing
 * to delete.
 *
 * Narrower than `removeProfileArtifactsForWorkspaces({ purgeMemory: true })`,
 * which also unlinks the teammate's workspace override file — a sibling of
 * this directory, not a child. Clearing what a teammate remembers must not
 * also discard how a project retuned it.
 */
export function clearMemoryNamespace(workspacePath: string, namespace?: string): boolean {
  // Validate the slug BEFORE it becomes a path segment. The containment check
  // below only proves the result is inside the workspace, and `../..` resolves
  // to a directory that is — so a recursive delete would have landed on real
  // project files. `memoryRoot` guards its own callers this way; the private
  // `memoryDir` that the containment walk uses does not.
  if (namespace !== undefined) assertSafeMemoryNamespace(namespace)
  const root = assertMemoryRootInsideWorkspace(workspacePath, namespace)
  if (!existsSync(root)) return false
  rmSync(root, { recursive: true, force: true })
  return true
}

function assertUnderMemory(
  workspacePath: string,
  targetPath: string,
  namespace?: string
): string {
  const realRoot = assertMemoryRootInsideWorkspace(workspacePath, namespace)
  const wsReal = workspaceRealRoot(workspacePath)
  const candidate = resolve(realRoot, targetPath)
  const checkContained = (resolved: string): void => {
    if (!isInsideRoot(resolved, realRoot)) {
      throw new Error(`Path escapes memory dir: ${targetPath}`)
    }
    if (!isInsideRoot(resolved, wsReal)) {
      throw new Error(`Path escapes workspace: ${targetPath}`)
    }
  }
  checkContained(candidate)
  if (existsSync(candidate)) {
    const real = realpathSync(candidate)
    checkContained(real)
    return real
  }
  return candidate
}

function readMemoryFileExcerpt(
  workspacePath: string,
  relPath: string,
  cap: number,
  namespace?: string
): string {
  const p = join(memoryRoot(workspacePath, namespace), relPath)
  if (!existsSync(p)) return ''
  try {
    const text = readFileSync(p, 'utf8')
    return text.length > cap ? truncateMemoryExcerpt(text, cap) : text
  } catch {
    return ''
  }
}

async function readMemoryFileExcerptAsync(
  workspacePath: string,
  relPath: string,
  cap: number,
  namespace?: string
): Promise<string> {
  const p = join(memoryRoot(workspacePath, namespace), relPath)
  if (!existsSync(p)) return ''
  try {
    const text = await readFile(p, 'utf8')
    return text.length > cap ? truncateMemoryExcerpt(text, cap) : text
  } catch {
    return ''
  }
}

/**
 * Cap an injected memory file at `cap` chars without cutting an entry in half:
 * prefer the last line boundary at/before the cap; hard-cut only when a single
 * line itself exceeds the cap. The dropped tail is always announced with an
 * explicit marker (never a bare ellipsis), so the model can tell a partial
 * file from a complete one and fetch the rest with memory_read.
 */
export function truncateMemoryExcerpt(text: string, cap: number): string {
  if (text.length <= cap) return text
  const window = text.slice(0, cap)
  const lineCut = window.lastIndexOf('\n')
  const head = lineCut > 0 ? window.slice(0, lineCut) : window.replace(/\s+$/, '')
  const shown = head.length
  return `${head}\n[truncated: showing first ${shown} of ${text.length} chars — memory_read the file for the rest]`
}

export function readMemoryIndex(
  workspacePath: string,
  cap = MEMORY_INDEX_CAP,
  namespace?: string
): string {
  return readMemoryFileExcerpt(workspacePath, 'index.md', cap, namespace)
}

export async function readMemoryIndexAsync(
  workspacePath: string,
  cap = MEMORY_INDEX_CAP,
  namespace?: string
): Promise<string> {
  return readMemoryFileExcerptAsync(workspacePath, 'index.md', cap, namespace)
}

export function readMemoryState(
  workspacePath: string,
  cap = MEMORY_STATE_CAP,
  namespace?: string
): string {
  return readMemoryFileExcerpt(workspacePath, 'state.md', cap, namespace)
}

export async function readMemoryStateAsync(
  workspacePath: string,
  cap = MEMORY_STATE_CAP,
  namespace?: string
): Promise<string> {
  return readMemoryFileExcerptAsync(workspacePath, 'state.md', cap, namespace)
}

/** Note filenames referenced by index.md links (`notes/<name>.md`). */
function indexLinkedNotes(workspacePath: string, namespace?: string): string[] {
  const text = readMemoryIndex(workspacePath, Number.MAX_SAFE_INTEGER, namespace)
  const names = new Set<string>()
  for (const m of text.matchAll(/notes\/([a-zA-Z0-9._-]+\.md)/g)) {
    names.add(m[1])
  }
  return [...names].sort()
}

export function listMemoryNotes(
  workspacePath: string,
  namespace?: string
): {
  notes: string[]
  indexedNotes: string[]
  hasState: boolean
} {
  const root = memoryRoot(workspacePath, namespace)
  const notesDir = join(root, 'notes')
  let notes: string[] = []
  try {
    notes = readdirSync(notesDir)
      .filter((n) => n.endsWith('.md'))
      .sort()
  } catch {
    notes = []
  }
  // index.md is intentionally NOT excerpted here: it is auto-injected into the
  // system prompt every step, so echoing it in memory_list only duplicates
  // context. memory_read fetches the full file on demand. Its link set is
  // reported instead, so index drift (unindexed notes / broken pointers)
  // is visible without inflating the injected prompt.
  return {
    notes,
    indexedNotes: indexLinkedNotes(workspacePath, namespace),
    hasState: existsSync(join(root, 'state.md'))
  }
}

export function readMemoryFile(
  workspacePath: string,
  relPath: string,
  namespace?: string
): string {
  const cleaned = relPath.replace(/^[/\\]+/, '')
  if (cleaned.includes('..')) throw new Error('Invalid memory path')
  const resolved = assertUnderMemory(workspacePath, cleaned, namespace)
  if (!existsSync(resolved)) {
    if (cleaned === 'state.md') {
      return '(state.md not created yet — use memory_write to create it)'
    }
    throw new Error(`File not found: ${cleaned}`)
  }
  return readFileSync(resolved, 'utf8')
}

export function writeMemoryFile(
  workspacePath: string,
  relPath: string,
  contents: string,
  namespace?: string
): string {
  ensureMemoryLayout(workspacePath, namespace)
  const cleaned = relPath.replace(/^[/\\]+/, '')
  if (cleaned.includes('..')) throw new Error('Invalid memory path')
  const resolved = assertUnderMemory(workspacePath, cleaned, namespace)
  mkdirSync(dirname(resolved), { recursive: true })
  writeFileSync(resolved, contents, 'utf8')
  // Report relative to the REAL memory root: on macOS tmpdir sits under the
  // /var → /private/var symlink, and relative() between the raw and real root
  // produced "../../../../…/private/var/…" (mac CI failure).
  return relative(
    assertMemoryRootInsideWorkspace(workspacePath, namespace),
    resolved
  ).replace(/\\/g, '/')
}
