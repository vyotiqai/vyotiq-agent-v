import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import type { ChatMessage, RewindRedoStatus } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { resolveInsideWorkspace } from '../workspace/safePath'
import { resolveRunDir, workspaceSessionsRoot } from '../storage/paths'
import type { RewindRunScope, RewindWritesPlan } from './checkpoints'
import { isActive } from './runRegistry'
import { invalidateListRunsCache } from './runListCache'
import {
  flushEventAppends,
  flushMessageAppends,
  flushStatusWrites,
  invalidateMessagesCache,
  loadMessagesAsync
} from './state'

/**
 * Redo for a rewind. Just before a rewind applies, the run's own files (its
 * record, events, todos, checks, receipt, checkpoint marks — every top-level
 * file, and each checkpoint's index and meta, never the immutable copies) and
 * the workspace files it is about to put back are copied aside. Redo copies
 * them back — only while nothing has moved since: every file Redo would
 * overwrite or delete (the run's files, the checkpoint marks, the workspace
 * files) is byte for byte what the rewind left. A rename, a loop, a Keep or
 * Undo, a new instruction — anything written after the rewind ends it, so
 * Redo never takes back something done since.
 */
const REDO_DIR = 'rewind-redo'
const MANIFEST = 'manifest.json'

type WorkspaceFileEntry = {
  path: string
  /** How the file was before the rewind: its content is under files/<n>, or it did not exist. */
  before: 'file' | 'absent'
  /** sha256 of that content, null when absent — to tell a file the rewind changed from one it left. */
  beforeHash?: string | null
  /** How the rewind left it: sha256 of its content, or null when it removed it. */
  afterHash?: string | null
}

type Manifest = {
  version: 1
  createdAt: string
  userMessageIndex: number
  /** Top-level run files that existed before the rewind (copied under run/). */
  runFiles: string[]
  /** Checkpoint index/meta files per scope run, relative to that run dir. */
  scopes: Array<{ runDir: string; files: string[] }>
  workspaceFiles: WorkspaceFileEntry[]
  /** sha256 of the record as the rewind left it; set once the rewind is done. */
  messagesHash?: string
  /** Every top-level run file as the rewind left it (name → sha256). */
  sealedRunFiles?: Record<string, string>
  /** Each scope's checkpoint marks as the rewind left them (rel → sha256), by scope index. */
  sealedScopeFiles?: Array<Record<string, string>>
}

export type { RewindRedoStatus }

function redoDir(runDir: string): string {
  return join(runDir, REDO_DIR)
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function fileHash(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null
    return sha256(readFileSync(path))
  } catch {
    return null
  }
}

function readManifest(runDir: string): Manifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(redoDir(runDir), MANIFEST), 'utf8')) as Manifest
    return raw?.version === 1 && Array.isArray(raw.runFiles) ? raw : null
  } catch {
    return null
  }
}

function writeManifest(runDir: string, manifest: Manifest): void {
  writeFileSync(join(redoDir(runDir), MANIFEST), JSON.stringify(manifest, null, 2), 'utf8')
}

/** Checkpoint marks a rewind rewrites: the index and each checkpoint's meta. */
function checkpointMarkFiles(runDir: string): string[] {
  const root = join(runDir, 'checkpoints')
  if (!existsSync(root)) return []
  const out: string[] = []
  if (existsSync(join(root, 'index.json'))) out.push('checkpoints/index.json')
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(root, entry.name, 'meta.json'))) {
      out.push(`checkpoints/${entry.name}/meta.json`)
    }
  }
  return out
}

function topLevelRunFiles(runDir: string): string[] {
  return readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
}

/** name → sha256 of each file, as they are now. */
function hashesOf(root: string, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) out[name] = fileHash(join(root, name)) ?? ''
  return out
}

function sameHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key])
}

function copyInto(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
}

async function recordHash(workspacePath: string, runId: string): Promise<string> {
  return sha256(JSON.stringify(await loadMessagesAsync(workspacePath, runId)))
}

/** Within the sessions root of this workspace — the only run dirs Redo may write. */
function isScopeRunDir(workspacePath: string, runDir: string): boolean {
  const root = resolve(workspaceSessionsRoot(workspacePath))
  const target = resolve(runDir)
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * Before a rewind applies: copy aside what it is about to change. `plan` is
 * the rewind's own preview; only the files it will put back are copied.
 */
export async function captureRewindRedo(input: {
  workspacePath: string
  runId: string
  userMessageIndex: number
  scopes: readonly RewindRunScope[]
  plan: RewindWritesPlan
}): Promise<void> {
  const runDir = resolveRunDir(input.workspacePath, input.runId)
  await flushMessageAppends(runDir)
  await flushEventAppends(runDir)
  await flushStatusWrites(runDir)
  const dir = redoDir(runDir)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const runFiles = topLevelRunFiles(runDir)
  for (const name of runFiles) copyInto(join(runDir, name), join(dir, 'run', name))

  const scopes: Manifest['scopes'] = []
  for (const [index, scope] of input.scopes.entries()) {
    if (!isScopeRunDir(input.workspacePath, scope.runDir)) continue
    const files = checkpointMarkFiles(scope.runDir)
    for (const rel of files) copyInto(join(scope.runDir, rel), join(dir, 'scopes', String(index), rel))
    scopes.push({ runDir: scope.runDir, files })
  }

  const workspaceFiles: WorkspaceFileEntry[] = []
  const seen = new Set<string>()
  // Every file the rewind may write — one it ends up leaving as you changed
  // it can still have been written by a newer turn's undo on the way.
  for (const file of input.plan.files) {
    if (!file.undoable || seen.has(file.path)) continue
    seen.add(file.path)
    const target = resolveInsideWorkspace(input.workspacePath, file.path)
    if (existsSync(target) && statSync(target).isFile()) {
      copyInto(target, join(dir, 'files', String(workspaceFiles.length)))
      workspaceFiles.push({ path: file.path, before: 'file', beforeHash: fileHash(target) })
    } else {
      workspaceFiles.push({ path: file.path, before: 'absent', beforeHash: null })
    }
  }

  writeManifest(runDir, {
    version: 1,
    createdAt: new Date().toISOString(),
    userMessageIndex: input.userMessageIndex,
    runFiles,
    scopes,
    workspaceFiles
  })
}

/** After the rewind: remember how it left the record and each file, to know later that nothing moved. */
export async function sealRewindRedo(workspacePath: string, runId: string): Promise<void> {
  const runDir = resolveRunDir(workspacePath, runId)
  const manifest = readManifest(runDir)
  if (!manifest) return
  await flushMessageAppends(runDir)
  await flushEventAppends(runDir)
  await flushStatusWrites(runDir)
  writeManifest(runDir, {
    ...manifest,
    messagesHash: await recordHash(workspacePath, runId),
    sealedRunFiles: hashesOf(runDir, topLevelRunFiles(runDir)),
    sealedScopeFiles: manifest.scopes.map((scope) => hashesOf(scope.runDir, checkpointMarkFiles(scope.runDir))),
    workspaceFiles: manifest.workspaceFiles.map((entry) => ({
      ...entry,
      afterHash: fileHash(resolveInsideWorkspace(workspacePath, entry.path))
    }))
  })
}

/** Drop what Redo would restore — a new instruction, or a rewind that did not go through. */
export function discardRewindRedo(workspacePath: string, runId: string): void {
  try {
    rmSync(redoDir(resolveRunDir(workspacePath, runId)), { recursive: true, force: true })
  } catch (err) {
    logger.warn('Could not drop a rewind redo', { scope: 'agent', correlationId: runId, err })
  }
}

export async function rewindRedoStatus(workspacePath: string, runId: string): Promise<RewindRedoStatus> {
  const runDir = resolveRunDir(workspacePath, runId)
  const manifest = readManifest(runDir)
  if (!manifest?.messagesHash) return { available: false, reason: 'none' }
  if (isActive(runId)) return { available: false, reason: 'running' }
  if ((await recordHash(workspacePath, runId)) !== manifest.messagesHash) {
    return { available: false, reason: 'record-changed' }
  }
  // Anything else Redo would overwrite: the run's own files and the checkpoint marks.
  await flushEventAppends(runDir)
  await flushStatusWrites(runDir)
  if (!manifest.sealedRunFiles || !sameHashes(hashesOf(runDir, topLevelRunFiles(runDir)), manifest.sealedRunFiles)) {
    return { available: false, reason: 'record-changed' }
  }
  for (const [index, scope] of manifest.scopes.entries()) {
    const sealed = manifest.sealedScopeFiles?.[index]
    if (!sealed || !sameHashes(hashesOf(scope.runDir, checkpointMarkFiles(scope.runDir)), sealed)) {
      return { available: false, reason: 'record-changed' }
    }
  }
  for (const entry of manifest.workspaceFiles) {
    if (fileHash(resolveInsideWorkspace(workspacePath, entry.path)) !== (entry.afterHash ?? null)) {
      return { available: false, reason: 'files-changed' }
    }
  }
  // The files Redo changes back: the ones the rewind actually changed.
  const changed = manifest.workspaceFiles.filter((entry) => (entry.beforeHash ?? null) !== (entry.afterHash ?? null)).length
  return { available: true, files: changed, userMessageIndex: manifest.userMessageIndex }
}

/**
 * Put back what the rewind took: the workspace files as they were, then the
 * run's record and marks. Refuses — changing nothing — unless Redo is still
 * available.
 */
export async function redoRewind(workspacePath: string, runId: string): Promise<{ messages: ChatMessage[] }> {
  const status = await rewindRedoStatus(workspacePath, runId)
  if (!status.available) {
    throw new Error(
      status.reason === 'running'
        ? 'The task is running; Redo waits until it stops.'
        : status.reason === 'none'
          ? 'There is no rewind to redo.'
          : 'Something changed since the rewind, so Redo would overwrite it.'
    )
  }
  const runDir = resolveRunDir(workspacePath, runId)
  const dir = redoDir(runDir)
  const manifest = readManifest(runDir)!

  for (const [index, entry] of manifest.workspaceFiles.entries()) {
    const target = resolveInsideWorkspace(workspacePath, entry.path)
    if (entry.before === 'file') copyInto(join(dir, 'files', String(index)), target)
    else rmSync(target, { force: true })
  }

  await flushMessageAppends(runDir)
  await flushEventAppends(runDir)
  await flushStatusWrites(runDir)
  const keep = new Set(manifest.runFiles)
  for (const name of topLevelRunFiles(runDir)) {
    if (!keep.has(name)) rmSync(join(runDir, name), { force: true })
  }
  for (const name of manifest.runFiles) copyInto(join(dir, 'run', name), join(runDir, name))
  for (const [index, scope] of manifest.scopes.entries()) {
    if (!isScopeRunDir(workspacePath, scope.runDir)) continue
    for (const rel of scope.files) {
      const from = join(dir, 'scopes', String(index), rel)
      if (existsSync(from)) copyInto(from, join(scope.runDir, rel))
    }
  }
  invalidateMessagesCache(runDir)
  // The task list reads status and review from these files through a short
  // cache; the rewind's own writes invalidate it, these copies must too.
  invalidateListRunsCache(workspacePath)
  rmSync(dir, { recursive: true, force: true })
  logger.info('Rewind redone', {
    scope: 'agent',
    correlationId: runId,
    count: manifest.workspaceFiles.length
  })
  return { messages: await loadMessagesAsync(workspacePath, runId) }
}

/** Where a run keeps its redo, inside the run dir. */
export function rewindRedoDirName(): string {
  return REDO_DIR
}
