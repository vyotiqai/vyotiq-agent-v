import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { resolveInsideWorkspace, assertResolvedInsideWorkspace } from '../../workspace/safePath'
import { withExclusiveWorkspaceMutation } from '@main/workspace/mutationQueue'
import { missingPathHint } from './read'

/**
 * Move or rename a file or folder inside the workspace. A terminal `mv` /
 * `move` was the only way before, and it is undoable only when the command
 * parser recognises it; this one is checkpointed like `delete` (the source is
 * recorded as deleted, everything at the destination as created), so Undo
 * puts it back.
 */

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel))
}

export function toolMove(workspaceRoot: string, fromArg: string, toArg: string, overwrite = false): string {
  const from = (fromArg ?? '').trim()
  const to = (toArg ?? '').trim()
  if (!from || !to) throw new Error('move requires from and to')
  const source = resolveInsideWorkspace(workspaceRoot, from)
  const dest = resolveInsideWorkspace(workspaceRoot, to)
  const root = resolve(realpathSync(workspaceRoot))
  if (resolve(source) === root || resolve(dest) === root) {
    throw new Error('Refusing to move the workspace root')
  }
  if (!existsSync(source)) throw new Error(missingPathHint(workspaceRoot, from))
  assertResolvedInsideWorkspace(workspaceRoot, source)
  if (resolve(source) === resolve(dest)) throw new Error(`${from} and ${to} are the same path`)
  const sourceIsDir = statSync(source).isDirectory()
  if (sourceIsDir && isInside(source, dest)) {
    throw new Error(`Cannot move ${from} into itself (${to})`)
  }
  // A case-only rename on a case-insensitive disk resolves to the same file:
  // that is a rename, not a collision.
  const sameFileDifferentCase = existsSync(dest) && resolve(source).toLowerCase() === resolve(dest).toLowerCase()
  if (existsSync(dest) && !sameFileDifferentCase) {
    if (statSync(dest).isDirectory()) {
      throw new Error(`${to} is an existing folder. Name the full new path (for example ${to}/${from.split('/').pop()}).`)
    }
    if (!overwrite) throw new Error(`${to} already exists. Pass overwrite: true to replace it.`)
    if (sourceIsDir) throw new Error(`${to} is a file; a folder cannot replace it.`)
    rmSync(dest, { force: false })
  }
  mkdirSync(dirname(dest), { recursive: true })
  try {
    renameSync(source, dest)
  } catch (err) {
    // A different volume (EXDEV) cannot be renamed across: copy, then remove.
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    cpSync(source, dest, { recursive: true, errorOnExist: true, force: false })
    rmSync(source, { recursive: true, force: false })
  }
  return sourceIsDir ? `Moved folder ${from} → ${to}` : `Moved ${from} → ${to}`
}

export async function toolMoveAsync(
  workspaceRoot: string,
  fromArg: string,
  toArg: string,
  overwrite = false
): Promise<string> {
  // Two paths change at once; take the whole tree, as a recursive delete does.
  return withExclusiveWorkspaceMutation(workspaceRoot, () => toolMove(workspaceRoot, fromArg, toArg, overwrite))
}

/**
 * The destination path of every file under a folder being moved, so each can
 * be recorded as created before the move (Undo removes them). Bounded: past
 * `cap` files the move is not undoable anyway (the source snapshot overflows).
 */
export function movedFileDestinations(
  workspaceRoot: string,
  fromArg: string,
  toArg: string,
  cap = 2000
): string[] {
  let source: string
  try {
    source = resolveInsideWorkspace(workspaceRoot, fromArg.trim())
    if (!statSync(source).isDirectory()) return [toArg.trim()]
  } catch {
    return []
  }
  const out: string[] = []
  const walk = (abs: string, rel: string): void => {
    if (out.length >= cap) return
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= cap) return
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(abs, entry.name), childRel)
      else if (entry.isFile()) out.push(`${toArg.trim().replace(/[\\/]+$/, '')}/${childRel}`)
    }
  }
  walk(source, '')
  return out
}
