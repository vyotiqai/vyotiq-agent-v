import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { resolveInsideWorkspace } from '../../workspace/safePath'
import { gitignoreMatcherForDir } from './gitignore'
import { IGNORED_DIRS } from './walk'
import { missingDirectoryHint } from './read'

export const LIST_DIR_CAP = 200
const NESTED_SUGGEST_CAP = 8
const NESTED_DIR_VISIT_CAP = 2000

function normalizeRelDir(pathArg: string): string {
  const rel = pathArg.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return rel === '.' ? '' : rel
}

/**
 * Bounded BFS for directories whose basename matches `leaf` (92c049d6: list_dir
 * `Sources` while the tree is `murmur-youtube-main/Sources`).
 */
export function findNestedDirectoryRels(
  workspaceRoot: string,
  leaf: string,
  cap = NESTED_SUGGEST_CAP
): string[] {
  const want = leaf.trim().replace(/\\/g, '/').split('/').filter(Boolean).pop()?.toLowerCase()
  if (!want || want === '.' || /[*?]/.test(want)) return []
  const hits: string[] = []
  const queue: { dir: string; rel: string }[] = [{ dir: workspaceRoot, rel: '' }]
  let visited = 0
  while (queue.length > 0 && hits.length < cap && visited < NESTED_DIR_VISIT_CAP) {
    const next = queue.shift()!
    let entries
    try {
      entries = readdirSync(next.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (hits.length >= cap || visited >= NESTED_DIR_VISIT_CAP) break
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      visited++
      const childRel = next.rel ? `${next.rel}/${entry.name}` : entry.name
      if (entry.name.toLowerCase() === want) hits.push(childRel.replace(/\\/g, '/'))
      if (IGNORED_DIRS.has(entry.name)) continue
      queue.push({ dir: join(next.dir, entry.name), rel: childRel })
    }
  }
  return hits
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

/** List one directory level, skipping ignored and gitignored entries. */
export function toolListDir(workspaceRoot: string, pathArg = '.', cap?: number): string {
  const relDir = normalizeRelDir(pathArg)
  const resolved = resolveInsideWorkspace(workspaceRoot, relDir || '.')
  if (!existsSync(resolved)) {
    const leaf = (relDir || pathArg).replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? pathArg
    throw new Error(
      missingDirectoryHint(workspaceRoot, pathArg, relDir, findNestedDirectoryRels(workspaceRoot, leaf))
    )
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${pathArg}. Use read for files.`)
  }

  const matcher = gitignoreMatcherForDir(workspaceRoot, relDir)
  const entries = readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => {
      if (IGNORED_DIRS.has(entry.name)) return false
      return !matcher.shouldIgnoreEntry(entry.name, entry.isDirectory())
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

  const limit = cap == null ? entries.length : Math.max(0, cap)
  const shown = entries.slice(0, limit).map((entry) => {
    if (entry.isDirectory()) return `[dir]  ${entry.name}/`
    let size = ''
    try {
      size = ` (${formatSize(statSync(join(resolved, entry.name)).size)})`
    } catch {
      size = ''
    }
    return `[file] ${entry.name}${size}`
  })

  if (shown.length === 0) return `${relDir || '.'} is empty`

  const suffix =
    entries.length > shown.length ? `\n… ${entries.length - shown.length} more entries` : ''
  return [`${relDir || '.'} (${entries.length} entries)`, ...shown].join('\n') + suffix
}
