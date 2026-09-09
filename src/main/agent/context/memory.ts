import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { dirname, join, relative, resolve } from 'path'
import { canonicalizeWorkspacePath } from '../../../shared/utils/workspacePath'
import { isInsideRoot } from '../../workspace/safePath'
import { MEMORY_INDEX_CAP, MEMORY_STATE_CAP } from './types'

export function memoryRoot(workspacePath: string): string {
  return join(workspacePath, '.vyotiq', 'memory')
}

function workspaceRealRoot(workspacePath: string): string {
  const root = canonicalizeWorkspacePath(workspacePath)
  return existsSync(root) ? realpathSync(root) : root
}

/** Memory root must resolve inside the workspace (blocks junction/symlink escape). */
function assertMemoryRootInsideWorkspace(workspacePath: string): string {
  const wsReal = workspaceRealRoot(workspacePath)
  const planned = join(wsReal, '.vyotiq', 'memory')
  const realRoot = existsSync(planned) ? realpathSync(planned) : planned
  if (!isInsideRoot(realRoot, wsReal)) {
    throw new Error('Memory directory escapes workspace')
  }
  return realRoot
}

export function ensureMemoryLayout(workspacePath: string): void {
  assertMemoryRootInsideWorkspace(workspacePath)
  const root = memoryRoot(workspacePath)
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

function assertUnderMemory(workspacePath: string, targetPath: string): string {
  const realRoot = assertMemoryRootInsideWorkspace(workspacePath)
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
  cap: number
): string {
  const p = join(memoryRoot(workspacePath), relPath)
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
  cap: number
): Promise<string> {
  const p = join(memoryRoot(workspacePath), relPath)
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

export function readMemoryIndex(workspacePath: string, cap = MEMORY_INDEX_CAP): string {
  return readMemoryFileExcerpt(workspacePath, 'index.md', cap)
}

export async function readMemoryIndexAsync(
  workspacePath: string,
  cap = MEMORY_INDEX_CAP
): Promise<string> {
  return readMemoryFileExcerptAsync(workspacePath, 'index.md', cap)
}

export function readMemoryState(workspacePath: string, cap = MEMORY_STATE_CAP): string {
  return readMemoryFileExcerpt(workspacePath, 'state.md', cap)
}

export async function readMemoryStateAsync(
  workspacePath: string,
  cap = MEMORY_STATE_CAP
): Promise<string> {
  return readMemoryFileExcerptAsync(workspacePath, 'state.md', cap)
}

/** Note filenames referenced by index.md links (`notes/<name>.md`). */
function indexLinkedNotes(workspacePath: string): string[] {
  const text = readMemoryIndex(workspacePath, Number.MAX_SAFE_INTEGER)
  const names = new Set<string>()
  for (const m of text.matchAll(/notes\/([a-zA-Z0-9._-]+\.md)/g)) {
    names.add(m[1])
  }
  return [...names].sort()
}

export function listMemoryNotes(workspacePath: string): {
  notes: string[]
  indexedNotes: string[]
  hasState: boolean
} {
  const root = memoryRoot(workspacePath)
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
    indexedNotes: indexLinkedNotes(workspacePath),
    hasState: existsSync(join(root, 'state.md'))
  }
}

export function readMemoryFile(workspacePath: string, relPath: string): string {
  const cleaned = relPath.replace(/^[/\\]+/, '')
  if (cleaned.includes('..')) throw new Error('Invalid memory path')
  const resolved = assertUnderMemory(workspacePath, cleaned)
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
  contents: string
): string {
  ensureMemoryLayout(workspacePath)
  const cleaned = relPath.replace(/^[/\\]+/, '')
  if (cleaned.includes('..')) throw new Error('Invalid memory path')
  const resolved = assertUnderMemory(workspacePath, cleaned)
  mkdirSync(dirname(resolved), { recursive: true })
  writeFileSync(resolved, contents, 'utf8')
  // Report relative to the REAL memory root: on macOS tmpdir sits under the
  // /var → /private/var symlink, and relative() between the raw and real root
  // produced "../../../../…/private/var/…" (mac CI failure).
  return relative(assertMemoryRootInsideWorkspace(workspacePath), resolved).replace(/\\/g, '/')
}
