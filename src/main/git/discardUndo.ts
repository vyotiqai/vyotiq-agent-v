import { createHash, randomUUID } from 'crypto'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { resolveInsideWorkspace } from '../workspace/safePath'

/**
 * Undo for Discard in Changes. Before git overwrites or the trash takes a
 * file, its bytes are copied here; Undo writes them back. A file that changed
 * again since the discard is left alone, so Undo never loses later work. The
 * OS trash still gets its copy as before — this is the in-app way back.
 *
 * Only file contents come back: what was staged returns as an unstaged change.
 */

/** How long an undo stays offered, and how many are kept. */
export const DISCARD_UNDO_TTL_MS = 24 * 60 * 60 * 1000
export const DISCARD_UNDO_KEEP = 20
const MAX_FILE_BYTES = 20 * 1024 * 1024

type UndoEntry = {
  rel: string
  /** The saved copy, relative to the undo folder; null when the file did not exist. */
  copy: string | null
  /** SHA-256 of what the discard left behind, or null when it left nothing. */
  after: string | null
}

type UndoManifest = { version: 1; workspace: string; createdAt: number; entries: UndoEntry[] }

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readIfFile(abs: string): Promise<Buffer | null> {
  try {
    const info = await stat(abs)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null
    return await readFile(abs)
  } catch {
    return null
  }
}

/** Copy what is about to be discarded; returns the pending undo to finish after the discard. */
export async function snapshotForUndo(
  root: string,
  workspace: string,
  paths: readonly string[]
): Promise<{ id: string; finish: (discarded: readonly string[]) => Promise<string | null> }> {
  const id = randomUUID()
  const dir = join(root, id)
  const saved = new Map<string, string>()
  await mkdir(join(dir, 'files'), { recursive: true })
  let n = 0
  for (const rel of paths) {
    let abs: string
    try {
      abs = resolveInsideWorkspace(workspace, rel)
    } catch {
      continue
    }
    const bytes = await readIfFile(abs)
    if (!bytes) continue
    const copy = join('files', String(n++))
    await writeFile(join(dir, copy), bytes)
    saved.set(rel, copy)
  }
  return {
    id,
    finish: async (discarded) => {
      const entries: UndoEntry[] = []
      for (const rel of discarded) {
        const copy = saved.get(rel)
        if (!copy) continue
        let after: string | null = null
        try {
          const now = await readIfFile(resolveInsideWorkspace(workspace, rel))
          after = now ? sha(now) : null
        } catch {
          after = null
        }
        entries.push({ rel, copy, after })
      }
      if (entries.length === 0) {
        await rm(dir, { recursive: true, force: true })
        return null
      }
      const manifest: UndoManifest = { version: 1, workspace, createdAt: Date.now(), entries }
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
      await pruneDiscardUndo(root)
      return id
    }
  }
}

/** Put discarded files back. A file that changed since the discard is skipped and named. */
export async function undoDiscard(
  root: string,
  workspace: string,
  id: string
): Promise<{ restored: string[]; skipped: string[]; detail: string }> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid undo id')
  const dir = join(root, id)
  let manifest: UndoManifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as UndoManifest
  } catch {
    throw new Error('That discard can no longer be undone. Its old copies are still in the trash.')
  }
  if (manifest.workspace !== workspace) throw new Error('That discard belongs to another workspace')
  if (Date.now() - manifest.createdAt > DISCARD_UNDO_TTL_MS) {
    await rm(dir, { recursive: true, force: true })
    throw new Error('That discard is too old to undo here. Its old copies are still in the trash.')
  }
  const restored: string[] = []
  const skipped: string[] = []
  for (const entry of manifest.entries) {
    if (!entry.copy) continue
    let abs: string
    try {
      abs = resolveInsideWorkspace(workspace, entry.rel)
    } catch {
      skipped.push(entry.rel)
      continue
    }
    const now = await readIfFile(abs)
    const nowHash = now ? sha(now) : null
    if (nowHash !== entry.after) {
      skipped.push(entry.rel)
      continue
    }
    await mkdir(dirname(abs), { recursive: true })
    await copyFile(join(dir, entry.copy), abs)
    restored.push(entry.rel)
  }
  await rm(dir, { recursive: true, force: true })
  const lead =
    restored.length === 0
      ? 'Nothing was put back'
      : restored.length === 1
        ? `Put back ${restored[0]}`
        : `Put back ${restored.length} files`
  const tail = skipped.length > 0 ? ` · ${skipped.length === 1 ? `${skipped[0]} changed` : `${skipped.length} files changed`} since, so ${skipped.length === 1 ? 'it was' : 'they were'} left alone` : ''
  return { restored, skipped, detail: `${lead}${tail}` }
}

/** Drop undo sets past their time, and all but the newest few. */
export async function pruneDiscardUndo(root: string, now = Date.now()): Promise<void> {
  let ids: string[]
  try {
    ids = await readdir(root)
  } catch {
    return
  }
  const sets: { id: string; createdAt: number }[] = []
  for (const id of ids) {
    try {
      const m = JSON.parse(await readFile(join(root, id, 'manifest.json'), 'utf8')) as UndoManifest
      sets.push({ id, createdAt: m.createdAt })
    } catch {
      // An unfinished snapshot older than a minute is a crash's leftover.
      try {
        const info = await stat(join(root, id))
        if (now - info.mtimeMs > 60_000) await rm(join(root, id), { recursive: true, force: true })
      } catch {
        // gone
      }
    }
  }
  sets.sort((a, b) => b.createdAt - a.createdAt)
  for (const [i, set] of sets.entries()) {
    if (i >= DISCARD_UNDO_KEEP || now - set.createdAt > DISCARD_UNDO_TTL_MS) {
      await rm(join(root, set.id), { recursive: true, force: true })
    }
  }
}
