/**
 * Bounded scan of workspace-authored markdown trees (`.vyotiq/rules`,
 * `.cursor/rules`, `.vyotiq/commands`, `.cursor/commands`).
 *
 * Rules and slash commands were structural clones of each other — same caps,
 * same `readCapped`, same sorted walk, and two fingerprints that had drifted
 * apart: the commands one only stat'ed the directories, so an edited command
 * stayed stale for the full TTL. Both now share this walker so a fix lands once.
 */
import { readdir, readFile, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { join, relative, sep } from 'path'

export const CACHE_TTL_MS = 30_000
/**
 * A single runaway file should not evict the harness from the prompt.
 * Characters, not bytes — it is applied to the decoded string, so a non-ASCII
 * file is allowed more bytes than the number suggests.
 */
export const MAX_FILE_CHARS = 64 * 1024
export const MAX_DIR_DEPTH = 3

export type ScannedFile = {
  /** File contents, capped at MAX_FILE_CHARS. */
  raw: string
  /** Base name including extension. */
  fileName: string
  absolutePath: string
  /** Posix-separated path relative to the workspace root. */
  relativePath: string
}

export type ScanDir = { dir: string; extensions: readonly string[] }

function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function hasExtension(fileName: string, extensions: readonly string[]): boolean {
  const lower = fileName.toLowerCase()
  return extensions.some((ext) => lower.endsWith(ext))
}

/**
 * Read a file, capped. `trim` drops surrounding whitespace and turns a
 * whitespace-only file into `null` — rules want that (an empty rule is not a
 * rule), commands keep their bytes as authored.
 */
export async function readCappedFile(
  filePath: string,
  options: { trim?: boolean } = {}
): Promise<string | null> {
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size === 0) return null
    const text = await readFile(filePath, 'utf8')
    if (options.trim) {
      if (text.length <= MAX_FILE_CHARS) return text.trim() || null
      return `${text.slice(0, MAX_FILE_CHARS).trim()}\n… (truncated)`
    }
    if (text.length <= MAX_FILE_CHARS) return text
    return `${text.slice(0, MAX_FILE_CHARS)}\n… (truncated)`
  } catch {
    return null
  }
}

type CollectOptions<T> = {
  workspacePath: string
  dirPath: string
  extensions: readonly string[]
  maxFiles: number
  out: T[]
  /** The only thing callers disagree on. Returning null skips the file without consuming a slot. */
  transform: (file: ScannedFile) => T | null
  /** Passed through to `readCappedFile`. */
  trim?: boolean
}

/**
 * Walk one directory tree, appending each transformed file to `out` until
 * `maxFiles` is reached. Entries are sorted by name so the prompt does not
 * churn between runs on the same workspace.
 */
export async function collectWorkspaceFiles<T>(options: CollectOptions<T>): Promise<void> {
  await walk(options, options.dirPath, 0)
}

async function walk<T>(options: CollectOptions<T>, dirPath: string, depth: number): Promise<void> {
  const { workspacePath, extensions, maxFiles, out, transform, trim } = options
  if (depth > MAX_DIR_DEPTH || out.length >= maxFiles) return
  let entries: Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of sorted) {
    if (out.length >= maxFiles) return
    const full = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await walk(options, full, depth + 1)
      continue
    }
    if (!hasExtension(entry.name, extensions)) continue
    const raw = await readCappedFile(full, { trim })
    if (!raw) continue
    const mapped = transform({
      raw,
      fileName: entry.name,
      absolutePath: full,
      relativePath: relative(workspacePath, full).split(sep).join('/')
    })
    if (mapped !== null) out.push(mapped)
  }
}

/**
 * Change fingerprint for a set of root files and rule/command directories.
 *
 * Async and per-file on purpose. This runs on every read — once per agent step
 * for rules — *including* cache hits, because the walk is what busts the
 * cache. A sync `statSync` version blocked the main thread at that cadence,
 * and a directory-mtime-only version missed edits to files inside the
 * directory: writing `foo.md` in place does not touch its parent's mtime.
 *
 * Issued together, assembled in order. The sequential version spent ~13
 * round-trips of latency per call — measured 12.7ms median on a 7-rule repo,
 * paid once per agent step even when nothing changed.
 */
export async function fingerprintWorkspaceFiles(options: {
  workspacePath: string
  rootFiles?: readonly string[]
  dirs: readonly ScanDir[]
  maxFiles: number
}): Promise<string> {
  const { workspacePath, rootFiles = [], dirs, maxFiles } = options
  const [rootParts, dirParts] = await Promise.all([
    Promise.all(
      rootFiles.map(async (name) => {
        try {
          return `${name}:${(await stat(join(workspacePath, name))).mtimeMs}`
        } catch (err) {
          return isNotFound(err) ? `${name}:-` : `${name}:?`
        }
      })
    ),
    Promise.all(
      dirs.map(async ({ dir, extensions }) => {
        const p = join(workspacePath, dir)
        try {
          const [dirStat, maxMtime] = await Promise.all([
            stat(p),
            maxFileMtimeMs(p, extensions, maxFiles, 0)
          ])
          return [`${dir}:${dirStat.mtimeMs}`, `${dir}:files:${maxMtime}`]
        } catch (err) {
          return [isNotFound(err) ? `${dir}:-` : `${dir}:?`]
        }
      })
    )
  ])
  return [...rootParts, ...dirParts.flat()].join('|')
}

/** Max mtime across a bounded walk so nested file edits bust the cache. */
async function maxFileMtimeMs(
  dirPath: string,
  extensions: readonly string[],
  maxFiles: number,
  depth: number
): Promise<number> {
  if (depth > MAX_DIR_DEPTH) return 0
  let entries: Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return 0
  }

  // Plan in entry order so the maxFiles cap still stops the walk at the same
  // entry it always did — including the later subdirectories it skips — then
  // issue the stats and recursions together instead of one await apiece.
  const subdirs: string[] = []
  const files: string[] = []
  let seen = 0
  for (const entry of entries) {
    if (seen >= maxFiles) break
    const full = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      subdirs.push(full)
      continue
    }
    if (!hasExtension(entry.name, extensions)) continue
    seen++
    files.push(full)
  }

  const mtimes = await Promise.all([
    ...subdirs.map((full) => maxFileMtimeMs(full, extensions, maxFiles, depth + 1)),
    ...files.map((full) => stat(full).then((st) => st.mtimeMs).catch(() => 0))
  ])
  return mtimes.reduce((max, mtime) => (mtime > max ? mtime : max), 0)
}
