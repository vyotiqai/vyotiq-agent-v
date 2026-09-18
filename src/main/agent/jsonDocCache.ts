import { readFile, stat } from 'fs/promises'

/**
 * Mtime-keyed raw-JSON parse cache shared by the Home aggregation paths
 * (`runStats`, `homeActivity`, `listRuns`). The same `receipt.json` /
 * `status.json` / `usage.json` was being fully read + parsed by up to three
 * pipelines per Home refresh cycle; unchanged files — the overwhelming
 * majority — are now read and parsed exactly once per write.
 *
 * Validity triple is size + mtimeMs + ctimeMs, mirroring the transcript
 * line-count cache: a rewrite (atomic replace) gets a fresh ctime, an
 * in-place edit bumps mtime, and a growing file changes size. This also
 * guards same-millisecond rewrites of same-sized files in tests.
 */
type Entry = { doc: unknown; size: number; mtimeMs: number; ctimeMs: number }

const cache = new Map<string, Entry>()
const MAX_ENTRIES = 512

export type CachedDoc =
  | { ok: true; doc: unknown; mtimeMs: number }
  | { ok: false }

function remember(path: string, entry: Entry): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(path)) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(path, entry)
}

/**
 * Read + parse a JSON file, reusing the previous parse while the validity
 * triple matches. Absent, corrupt, or unparseable files return `ok: false`
 * — callers already treat all three as "no document". A write that raced
 * the read is detected post-read and never cached.
 */
export async function readJsonDocCached(path: string): Promise<CachedDoc> {
  let before
  try {
    before = await stat(path)
  } catch {
    return { ok: false }
  }
  const hit = cache.get(path)
  if (
    hit &&
    hit.size === before.size &&
    hit.mtimeMs === before.mtimeMs &&
    hit.ctimeMs === before.ctimeMs
  ) {
    return { ok: true, doc: hit.doc, mtimeMs: before.mtimeMs }
  }
  try {
    const raw = await readFile(path, 'utf8')
    const doc = JSON.parse(raw) as unknown
    try {
      const after = await stat(path)
      if (
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs
      ) {
        remember(path, { doc, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs })
      }
    } catch {
      // File vanished or was replaced mid-read — return without caching.
    }
    return { ok: true, doc, mtimeMs: before.mtimeMs }
  } catch {
    return { ok: false }
  }
}

/** Test hook: drop every cached document. */
export function resetJsonDocCacheForTests(): void {
  cache.clear()
}
