import { createHash, randomBytes } from 'crypto'
import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
  type Stats
} from 'fs'
import {
  mkdir,
  open,
  opendir,
  rm,
  unlink,
  writeFile
} from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'path'
import {
  WORKSPACE_EDITOR_RECOVERY_MAX_BOOKMARKS,
  WORKSPACE_EDITOR_RECOVERY_MAX_CONTENT_BYTES,
  WORKSPACE_EDITOR_RECOVERY_MAX_SELECTIONS,
  WORKSPACE_EDITOR_RECOVERY_MAX_TABS,
  WORKSPACE_FILE_BINARY_MAX_BYTES,
  WORKSPACE_FILE_LIST_PAGE_MAX,
  WorkspaceEditorRecoverySnapshotSchema,
  type WorkspaceEditorRecoverySnapshot,
  type WorkspaceFileCreateRequest,
  type WorkspaceFileCreateResult,
  type WorkspaceFileDeleteRequest,
  type WorkspaceFileDeleteResult,
  type WorkspaceFileEncoding,
  type WorkspaceFileEntry,
  type WorkspaceFileKind,
  type WorkspaceFileListRequest,
  type WorkspaceFileListResult,
  type WorkspaceFileMoveRequest,
  type WorkspaceFileMoveResult,
  type WorkspaceFileReadResult,
  type WorkspaceFileSaveRequest,
  type WorkspaceFileSaveResult,
  type WorkspaceFileStatResult,
  type WorkspaceFileVersion
} from '../../shared/ipc'
import {
  assertInsideWorkspace,
  isSafeWorkspaceRelPath,
  canonicalizeWorkspacePath
} from '../../shared/utils/workspacePath'
import { workspacePathsEqual } from '../../shared/utils/workspacePathMatch'
import { assertResolvedInsideWorkspace } from './safePath'
import {
  atomicWriteBufferAsync,
  atomicWriteFileAsync,
  renameWithRetry
} from '../storage/atomicWrite'
import { workspaceId, workspaceMetaDir } from '../storage/paths'
import { withExclusiveWorkspaceMutation, withWorkspaceMutation } from './mutationQueue'

const MAX_RECOVERY_BYTES = 64 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 10_000
const READ_CHUNK_BYTES = 64 * 1024
const RECOVERY_PROJECT_REL = '.vyotiq/editor-recovery.json'
const RECOVERY_TOMBSTONE_NAME = 'editor-recovery-clear.json'
const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cjs',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.md',
  '.mdc',
  '.mjs',
  '.py',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.svg',
  '.svelte',
  '.swift',
  '.tsx',
  '.ts',
  '.toml',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml'
])

type RecoveryState = {
  sessionToken: string
  generation: number
}

const recoveryStateByWorkspace = new Map<string, RecoveryState>()

function workspaceIdentity(workspacePath: string): string {
  const root = workspaceRoot(workspacePath)
  return process.platform === 'win32' ? root.toLowerCase() : root
}

export type WorkspaceFileErrorCode =
  | 'FILE_NOT_FOUND'
  | 'FILE_NOT_DIRECTORY'
  | 'FILE_NOT_REGULAR'
  | 'FILE_TOO_LARGE'
  | 'FILE_BINARY'
  | 'FILE_CONFLICT'
  | 'FILE_COLLISION'
  | 'FILE_PERMISSION'
  | 'FILE_IO'
  | 'DIRECTORY_NOT_EMPTY'
  | 'WORKSPACE_ROOT'
  | 'PATH_UNSAFE'
  | 'SYMLINK_ESCAPE'
  | 'RECOVERY'

export class WorkspaceFileError extends Error {
  readonly code: WorkspaceFileErrorCode

  constructor(code: WorkspaceFileErrorCode, message: string) {
    super(message)
    this.name = 'WorkspaceFileError'
    this.code = code
  }
}

type ExistingPath = {
  display: string
  ioPath: string
  link: boolean
  linkInside: boolean
  stats: Stats
}

function normalizeRelativePath(pathArg: string, allowRoot = false): string {
  const raw = pathArg.replace(/\\/g, '/')
  const value = raw.replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (allowRoot && (value === '' || value === '.')) return ''
  if (!value || value.includes('\0') || !isSafeWorkspaceRelPath(value)) {
    throw new WorkspaceFileError('PATH_UNSAFE', `Unsafe workspace path: ${pathArg}`)
  }
  return value
}

function validateEntryName(nameArg: string): string {
  const name = nameArg
  const windowsInvalid =
    process.platform === 'win32' &&
    (/[<>:"|?*]/.test(name) ||
      /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name))
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('\0') ||
    name.includes('/') ||
    (process.platform === 'win32' && name.includes('\\')) ||
    !isSafeWorkspaceRelPath(name) ||
    windowsInvalid
  ) {
    throw new WorkspaceFileError('PATH_UNSAFE', `Unsafe file name: ${nameArg}`)
  }
  return name
}

function workspaceRoot(workspacePath: string): string {
  return canonicalizeWorkspacePath(workspacePath)
}

function displayPath(root: string, relPath: string): string {
  return relPath ? join(root, ...relPath.split('/')) : root
}

function mapFilesystemError(err: unknown, path: string): WorkspaceFileError {
  const code = err && typeof err === 'object' ? (err as NodeJS.ErrnoException).code : undefined
  if (code === 'ENOENT') return new WorkspaceFileError('FILE_NOT_FOUND', `File not found: ${path}`)
  if (code === 'ENOTDIR') return new WorkspaceFileError('FILE_NOT_DIRECTORY', `Not a directory: ${path}`)
  if (code === 'ELOOP') return new WorkspaceFileError('SYMLINK_ESCAPE', `Symlink path: ${path}`)
  if (code === 'ENXIO') return new WorkspaceFileError('FILE_NOT_REGULAR', `Not a regular file: ${path}`)
  if (code === 'EACCES' || code === 'EPERM') {
    return new WorkspaceFileError('FILE_PERMISSION', `Permission denied: ${path}`)
  }
  if (code === 'EEXIST') return new WorkspaceFileError('FILE_COLLISION', `Path already exists: ${path}`)
  if (code === 'ENOTEMPTY') {
    return new WorkspaceFileError('DIRECTORY_NOT_EMPTY', `Directory is not empty: ${path}`)
  }
  return new WorkspaceFileError(
    'FILE_IO',
    `${path}: ${err instanceof Error ? err.message : String(err)}`
  )
}

async function filesystemOperation<T>(
  path: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    if (err instanceof WorkspaceFileError) throw err
    throw mapFilesystemError(err, path)
  }
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function assertNoSymlinkPath(workspacePath: string, relPath: string, allowMissingFinal = false): void {
  const root = workspaceRoot(workspacePath)
  const normalized = normalizeRelativePath(relPath, true)
  let current = displayPath(root, normalized)
  while (isInsideRoot(root, current)) {
    try {
      const stats = lstatSync(current)
      if (stats.isSymbolicLink()) {
        throw new WorkspaceFileError('SYMLINK_ESCAPE', `Symlink paths are not supported: ${normalized}`)
      }
    } catch (err) {
      const code = err && typeof err === 'object' ? (err as NodeJS.ErrnoException).code : undefined
      if (allowMissingFinal && current === displayPath(root, normalized) && code === 'ENOENT') {
        current = dirname(current)
        continue
      }
      if (err instanceof WorkspaceFileError) throw err
      if (code !== 'ENOENT') throw mapFilesystemError(err, normalized)
    }
    if (relative(root, current) === '') break
    current = dirname(current)
  }
}

function inspectSymlink(root: string, path: string): { inside: boolean; target?: string } {
  try {
    const target = realpathSync(path)
    return { inside: isInsideRoot(root, target), target }
  } catch {
    return { inside: false }
  }
}

function existingPath(
  workspacePath: string,
  relPath: string,
  allowRoot = false
): ExistingPath {
  const root = workspaceRoot(workspacePath)
  const normalized = normalizeRelativePath(relPath, allowRoot)
  const display = displayPath(root, normalized)
  let stats: Stats
  try {
    stats = lstatSync(display)
  } catch (err) {
    throw mapFilesystemError(err, normalized)
  }

  if (stats.isSymbolicLink()) {
    throw new WorkspaceFileError('SYMLINK_ESCAPE', `Symlink paths are not supported: ${normalized}`)
  }

  try {
    assertResolvedInsideWorkspace(root, display)
  } catch {
    throw new WorkspaceFileError('SYMLINK_ESCAPE', `Path escapes workspace: ${normalized}`)
  }
  return { display, ioPath: display, link: false, linkInside: true, stats }
}

function existingDirectory(workspacePath: string, relPath: string): ExistingPath {
  assertNoSymlinkPath(workspacePath, relPath, true)
  const found = existingPath(workspacePath, relPath, true)
  if (!found.stats.isDirectory() && !found.link) {
    throw new WorkspaceFileError('FILE_NOT_DIRECTORY', `Not a directory: ${relPath || '.'}`)
  }
  if (found.link && !found.linkInside) {
    throw new WorkspaceFileError('SYMLINK_ESCAPE', `Directory link escapes workspace: ${relPath}`)
  }
  if (found.link) {
    let targetStats: Stats
    try {
      targetStats = statSync(found.ioPath)
    } catch {
      throw new WorkspaceFileError('FILE_NOT_DIRECTORY', `Broken directory link: ${relPath}`)
    }
    if (!targetStats.isDirectory()) {
      throw new WorkspaceFileError('FILE_NOT_DIRECTORY', `Not a directory: ${relPath || '.'}`)
    }
  }
  return found
}

function assertParentDirectory(workspacePath: string, parentRel: string): string {
  const root = workspaceRoot(workspacePath)
  const normalized = normalizeRelativePath(parentRel, true)
  const parent = displayPath(root, normalized)
  try {
    assertResolvedInsideWorkspace(root, parent)
    const stats = statSync(parent)
    if (!stats.isDirectory()) {
      throw new WorkspaceFileError('FILE_NOT_DIRECTORY', `Not a directory: ${normalized || '.'}`)
    }
  } catch (err) {
    if (err instanceof WorkspaceFileError) throw err
    if (err instanceof Error && /escapes workspace/i.test(err.message)) {
      throw new WorkspaceFileError('SYMLINK_ESCAPE', `Directory escapes workspace: ${normalized}`)
    }
    throw mapFilesystemError(err, normalized || '.')
  }
  return parent
}

function newPath(workspacePath: string, relPath: string): string {
  const root = workspaceRoot(workspacePath)
  const normalized = normalizeRelativePath(relPath)
  assertNoSymlinkPath(workspacePath, normalized, true)
  const candidate = displayPath(root, normalized)
  const parent = dirname(candidate)
  assertParentDirectory(workspacePath, relative(root, parent).replace(/\\/g, '/'))
  return candidate
}

function mutationPath(relPath: string): string {
  const normalized = normalizeRelativePath(relPath)
  validateEntryName(basename(normalized))
  return normalized
}

function kindForStats(stats: Stats): WorkspaceFileKind {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isFile()) return 'file'
  if (stats.isDirectory()) return 'directory'
  return 'other'
}

function entryFor(
  workspacePath: string,
  relPath: string,
  name: string,
  stats: Stats
): WorkspaceFileEntry {
  const root = workspaceRoot(workspacePath)
  const kind = kindForStats(stats)
  const symlinkTargetInsideWorkspace =
    kind === 'symlink' ? inspectSymlink(root, displayPath(root, relPath)).inside : null
  return {
    name,
    path: relPath,
    kind,
    size: stats.isFile() ? stats.size : 0,
    mtimeMs: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null,
    hidden: name.startsWith('.'),
    symlinkTargetInsideWorkspace
  }
}

function entryAfterOperation(workspacePath: string, relPath: string): WorkspaceFileEntry {
  const found = existingPath(workspacePath, relPath)
  return entryFor(workspacePath, normalizeRelativePath(relPath), found.display.split(/[\\/]/).pop() ?? relPath, found.stats)
}

function isLikelyText(path: string, bytes: Buffer): boolean {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).byteLength % 2 === 0
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return bytes.subarray(2).byteLength % 2 === 0
  }
  if (detectBomlessUtf16(bytes)) {
    return true
  }
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (TEXT_EXTENSIONS.has(extension)) return true
  let printable = 0
  const probe = bytes.subarray(0, Math.min(bytes.length, 8192))
  for (const byte of probe) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127)) printable++
  }
  return probe.length === 0 || printable / probe.length >= 0.85
}

function detectBomlessUtf16(bytes: Buffer): WorkspaceFileEncoding | null {
  if (bytes.byteLength < 4 || bytes.byteLength % 2 !== 0) return null
  const pairs = bytes.byteLength / 2
  for (const encoding of ['utf16le', 'utf16be'] as const) {
    let highZeroes = 0
    let printable = 0
    for (let index = 0; index < bytes.byteLength; index += 2) {
      const first = bytes[index] ?? 0
      const second = bytes[index + 1] ?? 0
      const high = encoding === 'utf16le' ? second : first
      const codeUnit = encoding === 'utf16le' ? (high << 8) | first : (high << 8) | second
      if (high === 0) highZeroes++
      if (codeUnit === 9 || codeUnit === 10 || codeUnit === 13 || (codeUnit >= 32 && codeUnit !== 127)) {
        printable++
      }
    }
    if (highZeroes / pairs >= 0.25 && printable / pairs >= 0.75) return encoding
  }
  return null
}

function decodeUtf16Be(bytes: Buffer): string {
  const body = bytes.subarray(bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0)
  if (body.length % 2 !== 0) {
    throw new WorkspaceFileError('FILE_BINARY', 'Malformed UTF-16 file')
  }
  const swapped = Buffer.allocUnsafe(body.length)
  for (let index = 0; index < swapped.length; index += 2) {
    swapped[index] = body[index + 1] ?? 0
    swapped[index + 1] = body[index] ?? 0
  }
  return swapped.toString('utf16le')
}

function decodeText(bytes: Buffer): {
  text: string
  encoding: WorkspaceFileEncoding
  bom: boolean
} {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: bytes.subarray(2).toString('utf16le'), encoding: 'utf16le', bom: true }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16Be(bytes), encoding: 'utf16be', bom: true }
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.subarray(3).toString('utf8'), encoding: 'utf8', bom: true }
  }
  const bomlessEncoding = detectBomlessUtf16(bytes)
  if (bomlessEncoding === 'utf16le') {
    return { text: bytes.toString('utf16le'), encoding: 'utf16le', bom: false }
  }
  if (bomlessEncoding === 'utf16be') {
    return { text: decodeUtf16Be(bytes), encoding: 'utf16be', bom: false }
  }
  return { text: bytes.toString('utf8'), encoding: 'utf8', bom: false }
}

function detectEol(text: string): WorkspaceFileReadResult['eol'] {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const bareCr = (text.match(/\r(?!\n)/g) ?? []).length
  const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length
  const kinds = Number(crlf > 0) + Number(bareCr > 0) + Number(bareLf > 0)
  if (kinds === 0) return 'none'
  if (kinds > 1) return 'mixed'
  if (crlf > 0) return 'crlf'
  if (bareCr > 0) return 'cr'
  return 'lf'
}

function applyEol(text: string, eol: WorkspaceFileReadResult['eol']): string {
  if (eol === 'none' || eol === 'mixed') return text
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (eol === 'crlf') return normalized.replace(/\n/g, '\r\n')
  if (eol === 'cr') return normalized.replace(/\n/g, '\r')
  return normalized
}

function encodeUtf16Be(text: string): Buffer {
  const little = Buffer.from(text, 'utf16le')
  for (let index = 0; index + 1 < little.length; index += 2) {
    const next = little[index]
    little[index] = little[index + 1] ?? 0
    little[index + 1] = next ?? 0
  }
  return little
}

function encodeText(
  text: string,
  encoding: WorkspaceFileEncoding,
  eol: WorkspaceFileReadResult['eol'],
  bom: boolean
): Buffer {
  const body = applyEol(text, eol)
  if (encoding === 'utf16le') {
    const little = Buffer.from(body, 'utf16le')
    return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), little]) : little
  }
  if (encoding === 'utf16be') {
    const big = encodeUtf16Be(body)
    return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), big]) : big
  }
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]) : Buffer.from(body, 'utf8')
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new WorkspaceFileError('FILE_BINARY', 'Binary content is not valid base64')
  }
  return Buffer.from(value, 'base64')
}

function versionFor(bytes: Buffer, stats: Stats): WorkspaceFileVersion {
  return {
    size: bytes.byteLength,
    mtimeMs: stats.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

function sameVersion(a: WorkspaceFileVersion, b: WorkspaceFileVersion): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.sha256 === b.sha256
}

async function assertExpectedVersion(
  path: string,
  expectedVersion: WorkspaceFileVersion,
  normalizedPath: string
): Promise<void> {
  try {
    const latest = await readBytesForEditor(path, normalizedPath)
    if (sameVersion(versionFor(latest.bytes, latest.stats), expectedVersion)) return
  } catch (err) {
    if (
      err instanceof WorkspaceFileError &&
      (err.code === 'FILE_NOT_FOUND' ||
        err.code === 'FILE_TOO_LARGE' ||
        err.code === 'FILE_CONFLICT' ||
        err.code === 'SYMLINK_ESCAPE')
    ) {
      throw new WorkspaceFileError(
        'FILE_CONFLICT',
        `File changed outside the editor: ${normalizedPath}`
      )
    }
    throw err
  }
  throw new WorkspaceFileError('FILE_CONFLICT', `File changed outside the editor: ${normalizedPath}`)
}

function assertContentSize(kind: 'text' | 'binary', bytes: Buffer): void {
  if (kind === 'text') return
  if (bytes.byteLength > WORKSPACE_FILE_BINARY_MAX_BYTES) {
    throw new WorkspaceFileError(
      'FILE_TOO_LARGE',
      `Binary file exceeds ${Math.round(WORKSPACE_FILE_BINARY_MAX_BYTES / (1024 * 1024))} MiB`
    )
  }
}

async function peekBytes(path: string, maxRead: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    const flags =
      process.platform === 'win32'
        ? 'r'
        : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    handle = await open(path, flags)
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new WorkspaceFileError('FILE_NOT_REGULAR', `Not a regular file: ${path}`)
    }
    const length = Math.min(Math.max(0, maxRead), stats.size)
    if (length <= 0) return Buffer.alloc(0)
    const chunk = Buffer.alloc(length)
    const { bytesRead } = await handle.read(chunk, 0, length, 0)
    return chunk.subarray(0, bytesRead)
  } catch (err) {
    if (err instanceof WorkspaceFileError) throw err
    throw mapFilesystemError(err, path)
  } finally {
    await handle?.close()
  }
}

/** Text files are unbounded; binaries still fail at WORKSPACE_FILE_BINARY_MAX_BYTES. */
async function readBytesForEditor(
  path: string,
  relPath: string
): Promise<{ bytes: Buffer; stats: Stats }> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    const flags =
      process.platform === 'win32'
        ? 'r'
        : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    handle = await open(path, flags)
    const stats = await handle.stat()
    await handle.close()
    handle = null
    if (!stats.isFile()) {
      throw new WorkspaceFileError('FILE_NOT_REGULAR', `Not a regular file: ${path}`)
    }
    const overBinary = stats.size > WORKSPACE_FILE_BINARY_MAX_BYTES
    if (overBinary) {
      const peek = await peekBytes(path, 8192)
      if (!isLikelyText(relPath, peek)) {
        throw new WorkspaceFileError(
          'FILE_TOO_LARGE',
          `Binary file exceeds ${Math.round(WORKSPACE_FILE_BINARY_MAX_BYTES / (1024 * 1024))} MiB`
        )
      }
    }
    return await readBytes(
      path,
      overBinary ? Number.POSITIVE_INFINITY : WORKSPACE_FILE_BINARY_MAX_BYTES
    )
  } catch (err) {
    if (err instanceof WorkspaceFileError) throw err
    throw mapFilesystemError(err, path)
  } finally {
    await handle?.close()
  }
}

async function readBytes(
  path: string,
  maxBytes = WORKSPACE_FILE_BINARY_MAX_BYTES
): Promise<{ bytes: Buffer; stats: Stats }> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    const flags =
      process.platform === 'win32'
        ? 'r'
        : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    handle = await open(path, flags)
    let stats = await handle.stat()
    if (!stats.isFile()) {
      throw new WorkspaceFileError('FILE_NOT_REGULAR', `Not a regular file: ${path}`)
    }
    if (stats.size > maxBytes) {
      throw new WorkspaceFileError(
        'FILE_TOO_LARGE',
        `File exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB`
      )
    }
    const chunks: Buffer[] = []
    let total = 0
    while (total <= maxBytes) {
      const length = Math.min(
        READ_CHUNK_BYTES,
        maxBytes + 1 - total
      )
      if (length <= 0) break
      const chunk = Buffer.alloc(length)
      const { bytesRead } = await handle.read(chunk, 0, length, total)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
      if (total > maxBytes) {
        throw new WorkspaceFileError(
          'FILE_TOO_LARGE',
          `File exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB`
        )
      }
    }
    stats = await handle.stat()
    const pathStats = lstatSync(path)
    if (pathStats.isSymbolicLink()) {
      throw new WorkspaceFileError('SYMLINK_ESCAPE', `Symlink appeared while reading: ${path}`)
    }
    if (!pathStats.isFile()) {
      throw new WorkspaceFileError('FILE_NOT_REGULAR', `Not a regular file: ${path}`)
    }
    if (pathStats.size !== stats.size || pathStats.mtimeMs !== stats.mtimeMs) {
      throw new WorkspaceFileError('FILE_CONFLICT', `File changed while reading: ${path}`)
    }
    return { bytes: Buffer.concat(chunks), stats }
  } catch (err) {
    if (err instanceof WorkspaceFileError) throw err
    throw mapFilesystemError(err, path)
  } finally {
    await handle?.close()
  }
}

function assertNotWorkspaceRoot(relPath: string): void {
  if (!normalizeRelativePath(relPath, true)) {
    throw new WorkspaceFileError('WORKSPACE_ROOT', 'Refusing to mutate the workspace root')
  }
}

function isDirectoryPath(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function recoveryAppPath(workspacePath: string): string {
  return join(workspaceMetaDir(workspaceId(workspaceRoot(workspacePath))), 'editor-recovery.json')
}

function recoveryAppTombstonePath(workspacePath: string): string {
  return join(
    workspaceMetaDir(workspaceId(workspaceRoot(workspacePath))),
    RECOVERY_TOMBSTONE_NAME
  )
}

function recoveryProjectPath(workspacePath: string): string {
  const root = workspaceRoot(workspacePath)
  const candidate = displayPath(root, RECOVERY_PROJECT_REL)
  assertNoSymlinkPath(workspacePath, RECOVERY_PROJECT_REL, true)
  if (existsSync(dirname(candidate))) {
    assertParentDirectory(workspacePath, '.vyotiq')
  } else {
    assertInsideWorkspace(root, RECOVERY_PROJECT_REL)
  }
  return candidate
}

function validateRecoverySnapshot(snapshot: WorkspaceEditorRecoverySnapshot): string {
  const parsed = WorkspaceEditorRecoverySnapshotSchema.parse(snapshot)
  if (parsed.tabs.length > WORKSPACE_EDITOR_RECOVERY_MAX_TABS) {
    throw new WorkspaceFileError('RECOVERY', 'Too many editor recovery tabs')
  }
  for (const tab of parsed.tabs) {
    if (tab.selections.length > WORKSPACE_EDITOR_RECOVERY_MAX_SELECTIONS) {
      throw new WorkspaceFileError('RECOVERY', 'Too many editor selections')
    }
    if (tab.bookmarks.length > WORKSPACE_EDITOR_RECOVERY_MAX_BOOKMARKS) {
      throw new WorkspaceFileError('RECOVERY', 'Too many editor bookmarks')
    }
  }
  let contentBytes = 0
  for (const tab of parsed.tabs) {
    contentBytes += Buffer.byteLength(tab.content, 'utf8')
    if (contentBytes > WORKSPACE_EDITOR_RECOVERY_MAX_CONTENT_BYTES) {
      throw new WorkspaceFileError('RECOVERY', 'Editor recovery content is too large')
    }
  }
  const serialized = JSON.stringify(parsed)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECOVERY_BYTES) {
    throw new WorkspaceFileError('RECOVERY', 'Editor recovery state is too large')
  }
  return serialized
}

async function readRecoveryFile(
  path: string,
  workspacePath?: string
): Promise<WorkspaceEditorRecoverySnapshot | null> {
  try {
    if (workspacePath) assertNoSymlinkPath(workspacePath, RECOVERY_PROJECT_REL, true)
    const { bytes } = await readBytes(path, MAX_RECOVERY_BYTES)
    const raw = bytes.toString('utf8')
    return WorkspaceEditorRecoverySnapshotSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

type RecoveryTombstone = {
  version: 1
  clearedAt: string
  generation: number
}

async function readRecoveryTombstone(path: string): Promise<RecoveryTombstone | null> {
  try {
    const { bytes } = await readBytes(path, 16 * 1024)
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<RecoveryTombstone>
    if (
      candidate.version !== 1 ||
      typeof candidate.clearedAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.clearedAt)) ||
      typeof candidate.generation !== 'number' ||
      !Number.isInteger(candidate.generation) ||
      candidate.generation < 0
    ) {
      return null
    }
    return {
      version: 1,
      clearedAt: candidate.clearedAt,
      generation: candidate.generation
    }
  } catch {
    return null
  }
}

async function listWorkspaceDirectoryUnsafe(
  request: WorkspaceFileListRequest
): Promise<WorkspaceFileListResult> {
  const directory = existingDirectory(request.workspacePath, request.path)
  const entries: Dirent[] = []
  let truncated = false
  let handle: Awaited<ReturnType<typeof opendir>>
  try {
    handle = await opendir(directory.ioPath)
  } catch (err) {
    throw mapFilesystemError(err, request.path || '.')
  }
  try {
    for await (const entry of handle) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        truncated = true
        break
      }
      entries.push(entry)
    }
  } catch (err) {
    if (err instanceof WorkspaceFileError) throw err
    throw mapFilesystemError(err, request.path || '.')
  } finally {
    await handle.close().catch(() => undefined)
  }
  const root = workspaceRoot(request.workspacePath)
  const relDir = normalizeRelativePath(request.path, true)
  // Sort from Dirent types (free) instead of stat-ing all 10k entries; only
  // the returned page (≤200) pays an lstat for size/mtime details.
  const dirRank = (entry: Dirent): number =>
    entry.isDirectory() ? 0 : entry.isSymbolicLink() ? 1 : 2
  const ordered = [...entries].sort(
    (a, b) => dirRank(a) - dirRank(b) || a.name.localeCompare(b.name)
  )
  const start = Math.min(request.offset, ordered.length)
  const page = ordered.slice(start, start + Math.min(request.limit, WORKSPACE_FILE_LIST_PAGE_MAX))
  return {
    path: relDir,
    entries: page.map((entry) => {
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
      const childPath = displayPath(root, childRel)
      let stats: Stats | null = null
      try {
        stats = lstatSync(childPath)
      } catch {
        stats = null
      }
      return stats
        ? entryFor(request.workspacePath, childRel, entry.name, stats)
        : {
            name: entry.name,
            path: childRel,
            kind: 'other',
            size: 0,
            mtimeMs: null,
            hidden: entry.name.startsWith('.'),
            symlinkTargetInsideWorkspace: null
          }
    }),
    total: ordered.length,
    nextOffset: start + page.length < ordered.length ? start + page.length : null,
    truncated
  }
}

export async function listWorkspaceDirectory(
  request: WorkspaceFileListRequest
): Promise<WorkspaceFileListResult> {
  return withExclusiveWorkspaceMutation(request.workspacePath, () =>
    listWorkspaceDirectoryUnsafe(request)
  )
}

async function readWorkspaceFileUnsafe(
  workspacePath: string,
  relPath: string
): Promise<WorkspaceFileReadResult> {
  assertNoSymlinkPath(workspacePath, relPath)
  const found = existingPath(workspacePath, relPath)
  if (found.stats.isDirectory() || (found.link && isDirectoryPath(found.ioPath))) {
    throw new WorkspaceFileError('FILE_NOT_DIRECTORY', `Cannot edit a directory: ${relPath}`)
  }
  if (!found.stats.isFile()) {
    throw new WorkspaceFileError('FILE_NOT_REGULAR', `Cannot edit a non-regular file: ${relPath}`)
  }
  if (found.link && !found.linkInside) {
    throw new WorkspaceFileError('SYMLINK_ESCAPE', `Path escapes workspace: ${relPath}`)
  }
  const normalized = normalizeRelativePath(relPath)
  const { bytes, stats } = await readBytesForEditor(found.ioPath, normalized)
  const binary = !isLikelyText(normalized, bytes)
  const version = versionFor(bytes, stats)
  if (binary) {
    if (bytes.byteLength > WORKSPACE_FILE_BINARY_MAX_BYTES) {
      throw new WorkspaceFileError(
        'FILE_TOO_LARGE',
        `Binary file exceeds ${Math.round(WORKSPACE_FILE_BINARY_MAX_BYTES / (1024 * 1024))} MiB`
      )
    }
    return {
      path: normalized,
      kind: 'binary',
      content: bytes.toString('base64'),
      encoding: 'binary',
      eol: 'none',
      bom: false,
      size: bytes.byteLength,
      version,
      truncated: false
    }
  }
  const decoded = decodeText(bytes)
  return {
    path: normalized,
    kind: 'text',
    content: decoded.text,
    encoding: decoded.encoding,
    eol: detectEol(decoded.text),
    bom: decoded.bom,
    size: bytes.byteLength,
    version,
    truncated: false
  }
}

export async function readWorkspaceFile(
  workspacePath: string,
  relPath: string
): Promise<WorkspaceFileReadResult> {
  const normalized = normalizeRelativePath(relPath)
  return withWorkspaceMutation(workspacePath, normalized, () =>
    readWorkspaceFileUnsafe(workspacePath, normalized)
  )
}

/** Stat-only change probe for open editor tabs — same path safety as reads, zero content IO. */
export async function statWorkspaceFile(
  workspacePath: string,
  relPath: string
): Promise<WorkspaceFileStatResult> {
  const normalized = normalizeRelativePath(relPath)
  return withWorkspaceMutation(workspacePath, normalized, async () => {
    assertNoSymlinkPath(workspacePath, normalized)
    let found: ExistingPath | null = null
    try {
      found = existingPath(workspacePath, normalized)
    } catch (err) {
      if (!(err instanceof WorkspaceFileError) || err.code !== 'FILE_NOT_FOUND') throw err
    }
    if (!found) {
      return { path: normalized, exists: false, size: 0, mtimeMs: 0 }
    }
    if (found.link && !found.linkInside) {
      throw new WorkspaceFileError('SYMLINK_ESCAPE', `Path escapes workspace: ${normalized}`)
    }
    return {
      path: normalized,
      exists: true,
      size: found.stats.size,
      mtimeMs: found.stats.mtimeMs
    }
  })
}

/** Bound-handle attachment read — revalidates the opened object against a symlink swap. */
export async function readWorkspaceAttachmentBytes(
  workspacePath: string,
  relPath: string,
  maxBytes: number
): Promise<Buffer> {
  const normalized = normalizeRelativePath(relPath)
  return withWorkspaceMutation(workspacePath, normalized, async () => {
    assertNoSymlinkPath(workspacePath, normalized)
    const found = existingPath(workspacePath, normalized)
    if (!found.stats.isFile()) {
      throw new WorkspaceFileError('FILE_NOT_REGULAR', 'Not a file')
    }
    if (found.link && !found.linkInside) {
      throw new WorkspaceFileError('SYMLINK_ESCAPE', `Path escapes workspace: ${normalized}`)
    }
    const { bytes } = await readBytes(found.ioPath, maxBytes)
    return bytes
  })
}

async function saveWorkspaceFileUnsafe(
  request: WorkspaceFileSaveRequest
): Promise<WorkspaceFileSaveResult> {
  const normalized = normalizeRelativePath(request.path)
  assertNoSymlinkPath(request.workspacePath, normalized, true)
  const root = workspaceRoot(request.workspacePath)
  const candidate = newPath(request.workspacePath, normalized)
  let current: ExistingPath | null = null
  try {
    current = existingPath(request.workspacePath, normalized)
  } catch (err) {
    if (!(err instanceof WorkspaceFileError) || err.code !== 'FILE_NOT_FOUND') throw err
  }
  if (current && current.stats.isDirectory()) {
    throw new WorkspaceFileError('FILE_NOT_DIRECTORY', `Cannot save a directory: ${normalized}`)
  }
  if (current && !current.stats.isFile()) {
    throw new WorkspaceFileError('FILE_NOT_REGULAR', `Cannot save a non-regular file: ${normalized}`)
  }
  if (current?.link && !current.linkInside) {
    throw new WorkspaceFileError('SYMLINK_ESCAPE', `Path escapes workspace: ${normalized}`)
  }
  if (!current && request.expectedVersion) {
    throw new WorkspaceFileError('FILE_CONFLICT', `File was removed while editing: ${normalized}`)
  }
  if (!current) mutationPath(normalized)
  if (current && request.expectedVersion) {
    const { bytes, stats } = await readBytesForEditor(current.ioPath, normalized)
    const actual = versionFor(bytes, stats)
    if (!sameVersion(actual, request.expectedVersion)) {
      throw new WorkspaceFileError('FILE_CONFLICT', `File changed outside the editor: ${normalized}`)
    }
  } else if (current && !request.replaceExisting) {
    throw new WorkspaceFileError('FILE_COLLISION', `File already exists: ${normalized}`)
  }
  if (
    (request.kind === 'text' && request.encoding === 'binary') ||
    (request.kind === 'binary' && request.encoding !== 'binary')
  ) {
    throw new WorkspaceFileError('FILE_BINARY', 'File mode and encoding do not match')
  }

  const bytes =
    request.kind === 'binary'
      ? decodeBase64(request.content)
      : encodeText(request.content, request.encoding, request.eol, request.bom)
  assertContentSize(request.kind, bytes)
  assertParentDirectory(request.workspacePath, relative(root, dirname(candidate)).replace(/\\/g, '/'))
  if (!current && existsSync(candidate)) {
    throw new WorkspaceFileError('FILE_COLLISION', `File appeared while saving: ${normalized}`)
  }
  const mode = current ? current.stats.mode & 0o7777 : 0o644
  assertNoSymlinkPath(request.workspacePath, normalized, true)
  const verifyBeforeReplace = async (): Promise<void> => {
    assertNoSymlinkPath(request.workspacePath, normalized, true)
    if (request.expectedVersion) {
      await assertExpectedVersion(candidate, request.expectedVersion, normalized)
    } else if (!current && existsSync(candidate)) {
      throw new WorkspaceFileError('FILE_COLLISION', `File appeared while saving: ${normalized}`)
    }
  }
  await filesystemOperation(normalized, () =>
    atomicWriteBufferAsync(candidate, bytes, mode, verifyBeforeReplace)
  )
  const stats = statSync(candidate)
  return { path: normalized, version: versionFor(bytes, stats), size: bytes.byteLength }
}

export async function saveWorkspaceFile(
  request: WorkspaceFileSaveRequest
): Promise<WorkspaceFileSaveResult> {
  const normalized = normalizeRelativePath(request.path)
  return withWorkspaceMutation(request.workspacePath, normalized, () =>
    saveWorkspaceFileUnsafe(request)
  )
}

async function createWorkspaceFileUnsafe(
  request: WorkspaceFileCreateRequest
): Promise<WorkspaceFileCreateResult> {
  const parentRel = normalizeRelativePath(request.parentPath, true)
  const name = validateEntryName(request.name)
  assertNoSymlinkPath(request.workspacePath, parentRel, true)
  const parent = assertParentDirectory(request.workspacePath, parentRel)
  const root = workspaceRoot(request.workspacePath)
  const targetRel = parentRel ? `${parentRel}/${name}` : name
  const target = join(parent, name)
  const exists = existsSync(target)
  if (exists && !request.replaceExisting) {
    throw new WorkspaceFileError('FILE_COLLISION', `Path already exists: ${targetRel}`)
  }
  if (request.kind === 'directory') {
    if (exists) {
      if (!isDirectoryPath(target)) {
        throw new WorkspaceFileError('FILE_COLLISION', `File blocks directory creation: ${targetRel}`)
      }
    } else {
      await filesystemOperation(targetRel, () => mkdir(target))
    }
  } else if (exists) {
    const stats = lstatSync(target)
    if (!stats.isFile()) {
      throw new WorkspaceFileError('FILE_COLLISION', `Directory blocks file creation: ${targetRel}`)
    }
    await filesystemOperation(targetRel, () =>
      atomicWriteBufferAsync(target, Buffer.alloc(0), stats.mode & 0o7777)
    )
  } else {
    await filesystemOperation(targetRel, () => writeFile(target, Buffer.alloc(0), { flag: 'wx' }))
  }
  assertResolvedInsideWorkspace(root, target)
  return { entry: entryAfterOperation(request.workspacePath, targetRel) }
}

export async function createWorkspaceFile(
  request: WorkspaceFileCreateRequest
): Promise<WorkspaceFileCreateResult> {
  const parentRel = normalizeRelativePath(request.parentPath, true)
  const name = validateEntryName(request.name)
  const targetRel = parentRel ? `${parentRel}/${name}` : name
  return withWorkspaceMutation(request.workspacePath, targetRel, () =>
    createWorkspaceFileUnsafe(request)
  )
}

async function moveWorkspaceFileUnsafe(
  request: WorkspaceFileMoveRequest
): Promise<WorkspaceFileMoveResult> {
  const from = normalizeRelativePath(request.fromPath)
  const to = mutationPath(request.toPath)
  assertNoSymlinkPath(request.workspacePath, from)
  assertNoSymlinkPath(request.workspacePath, to, true)
  assertNotWorkspaceRoot(from)
  const source = existingPath(request.workspacePath, from)
  const target = newPath(request.workspacePath, to)
  if (workspacePathsEqual(source.display, target)) {
    throw new WorkspaceFileError('PATH_UNSAFE', 'Source and destination are the same path')
  }
  if (!source.link && !source.stats.isDirectory()) assertResolvedInsideWorkspace(workspaceRoot(request.workspacePath), source.display)
  if (!source.linkInside && source.link) {
    // A symlink itself can be moved safely without following its target.
  }
  if (isInsideRoot(source.display, target)) {
    throw new WorkspaceFileError('PATH_UNSAFE', 'Cannot move a path into itself')
  }
  let replacementBackup: string | null = null
  if (existsSync(target)) {
    if (!request.replaceExisting) {
      throw new WorkspaceFileError('FILE_COLLISION', `Path already exists: ${to}`)
    }
    const targetStats = lstatSync(target)
    if (targetStats.isDirectory()) {
      if (!source.stats.isDirectory()) {
        throw new WorkspaceFileError('FILE_COLLISION', `Directory blocks replacement: ${to}`)
      }
      if (readdirSyncSafe(target).length > 0) {
        throw new WorkspaceFileError('FILE_COLLISION', `Target directory is not empty: ${to}`)
      }
    }
    replacementBackup = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.replace.tmp`
    await filesystemOperation(to, () => renameWithRetry(target, replacementBackup!))
  }
  try {
    await filesystemOperation(to, async () => {
      assertNoSymlinkPath(request.workspacePath, from, true)
      assertNoSymlinkPath(request.workspacePath, to, true)
      await renameWithRetry(source.display, target)
      assertNoSymlinkPath(request.workspacePath, to)
    })
  } catch (err) {
    if (replacementBackup) {
      try {
        await renameWithRetry(replacementBackup, target)
      } catch {
        // Preserve the original operation error; the backup remains for recovery.
      }
    }
    if (err instanceof WorkspaceFileError) throw err
    throw mapFilesystemError(err, to)
  }
  if (replacementBackup) await unlinkIfPresent(replacementBackup)
  return { entry: entryAfterOperation(request.workspacePath, to) }
}

export async function moveWorkspaceFile(
  request: WorkspaceFileMoveRequest
): Promise<WorkspaceFileMoveResult> {
  return withExclusiveWorkspaceMutation(request.workspacePath, () =>
    moveWorkspaceFileUnsafe(request)
  )
}

async function deleteWorkspaceFileUnsafe(
  request: WorkspaceFileDeleteRequest
): Promise<WorkspaceFileDeleteResult> {
  const normalized = normalizeRelativePath(request.path, true)
  assertNotWorkspaceRoot(normalized)
  assertNoSymlinkPath(request.workspacePath, normalized)
  const found = existingPath(request.workspacePath, normalized)
  if (found.stats.isDirectory() && !request.recursive) {
    if (readdirSyncSafe(found.display).length > 0) {
      throw new WorkspaceFileError('DIRECTORY_NOT_EMPTY', `Directory is not empty: ${normalized}`)
    }
  }
  if (found.stats.isDirectory()) {
    await filesystemOperation(normalized, () =>
      rm(found.display, { recursive: request.recursive, force: false })
    )
  } else {
    await filesystemOperation(normalized, () => unlink(found.display))
  }
  return { path: normalized, kind: kindForStats(found.stats) }
}

export async function deleteWorkspaceFile(
  request: WorkspaceFileDeleteRequest
): Promise<WorkspaceFileDeleteResult> {
  const normalized = normalizeRelativePath(request.path, true)
  if (request.recursive || !normalized) {
    return withExclusiveWorkspaceMutation(request.workspacePath, () =>
      deleteWorkspaceFileUnsafe(request)
    )
  }
  return withWorkspaceMutation(request.workspacePath, normalized, () =>
    deleteWorkspaceFileUnsafe(request)
  )
}

function readdirSyncSafe(path: string): string[] {
  try {
    return lstatSync(path).isDirectory() ? readdirSync(path) : []
  } catch {
    return []
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
  }
}

async function saveEditorRecoveryUnsafe(
  workspacePath: string,
  snapshot: WorkspaceEditorRecoverySnapshot
): Promise<true> {
  let serialized: string
  try {
    serialized = validateRecoverySnapshot(snapshot)
    const appPath = recoveryAppPath(workspacePath)
    const projectPath = recoveryProjectPath(workspacePath)
    mkdirSync(dirname(appPath), { recursive: true })
    await atomicWriteFileAsync(appPath, serialized)
    const projectParent = dirname(projectPath)
    await mkdir(projectParent, { recursive: true })
    assertResolvedInsideWorkspace(workspaceRoot(workspacePath), projectParent)
    await atomicWriteFileAsync(projectPath, serialized, 0o644, () => {
      assertNoSymlinkPath(workspacePath, RECOVERY_PROJECT_REL, true)
      assertResolvedInsideWorkspace(workspaceRoot(workspacePath), projectParent)
    })
    await unlinkIfPresent(recoveryAppTombstonePath(workspacePath))
  } catch (err) {
    if (err instanceof WorkspaceFileError && err.code === 'RECOVERY') throw err
    throw new WorkspaceFileError(
      'RECOVERY',
      `App recovery saved, but project recovery mirror failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return true
}

export async function saveEditorRecovery(
  workspacePath: string,
  snapshot: WorkspaceEditorRecoverySnapshot,
  sessionToken: string,
  generation: number
): Promise<true> {
  return withExclusiveWorkspaceMutation(workspacePath, async () => {
    const state = recoveryStateByWorkspace.get(workspaceIdentity(workspacePath))
    if (!state || state.sessionToken !== sessionToken) {
      throw new WorkspaceFileError('RECOVERY', 'Recovery session is stale')
    }
    if (generation < state.generation) return true
    const result = await saveEditorRecoveryUnsafe(workspacePath, snapshot)
    state.generation = generation
    return result
  })
}

async function loadEditorRecoveryUnsafe(workspacePath: string): Promise<{
  snapshot: WorkspaceEditorRecoverySnapshot | null
  source: 'app' | 'project' | 'none'
}> {
  const appPath = recoveryAppPath(workspacePath)
  let projectPath: string | null = null
  try {
    projectPath = recoveryProjectPath(workspacePath)
  } catch {
    // An escaping or malformed project mirror must not block app recovery.
  }
  const [appSnapshot, projectSnapshot] = await Promise.all([
    readRecoveryFile(appPath),
    projectPath ? readRecoveryFile(projectPath, workspacePath) : Promise.resolve(null)
  ])
  const tombstone = await readRecoveryTombstone(recoveryAppTombstonePath(workspacePath))
  const clearTime = tombstone ? Date.parse(tombstone.clearedAt) : Number.NEGATIVE_INFINITY
  const currentApp = appSnapshot && Date.parse(appSnapshot.savedAt) > clearTime ? appSnapshot : null
  const currentProject =
    projectSnapshot && Date.parse(projectSnapshot.savedAt) > clearTime ? projectSnapshot : null
  if (!currentApp && !currentProject) return { snapshot: null, source: 'none' }
  if (!currentApp) return { snapshot: currentProject, source: 'project' }
  if (!currentProject) return { snapshot: currentApp, source: 'app' }
  const appTime = Date.parse(currentApp.savedAt)
  const projectTime = Date.parse(currentProject.savedAt)
  return projectTime > appTime
    ? { snapshot: currentProject, source: 'project' }
    : { snapshot: currentApp, source: 'app' }
}

export async function loadEditorRecovery(workspacePath: string): Promise<{
  snapshot: WorkspaceEditorRecoverySnapshot | null
  source: 'app' | 'project' | 'none'
  sessionToken: string
  generation: number
}> {
  return withExclusiveWorkspaceMutation(workspacePath, async () => {
    const loaded = await loadEditorRecoveryUnsafe(workspacePath)
    const previous = recoveryStateByWorkspace.get(workspaceIdentity(workspacePath))
    const state: RecoveryState = {
      sessionToken: randomBytes(16).toString('hex'),
      generation: previous?.generation ?? 0
    }
    recoveryStateByWorkspace.set(workspaceIdentity(workspacePath), state)
    return { ...loaded, sessionToken: state.sessionToken, generation: state.generation }
  })
}

async function clearEditorRecoveryUnsafe(workspacePath: string, generation: number): Promise<true> {
  const tombstonePath = recoveryAppTombstonePath(workspacePath)
  mkdirSync(dirname(tombstonePath), { recursive: true })
  await atomicWriteFileAsync(
    tombstonePath,
    JSON.stringify({
      version: 1,
      clearedAt: new Date().toISOString(),
      generation
    })
  )
  const paths: string[] = []
  try {
    paths.push(recoveryProjectPath(workspacePath))
  } catch {
    // Nothing safe to remove from an invalid project mirror path.
  }
  paths.push(recoveryAppPath(workspacePath))
  for (const path of paths) {
    try {
      await unlink(path)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        throw new WorkspaceFileError(
          'RECOVERY',
          `Could not clear editor recovery: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
  return true
}

export async function clearEditorRecovery(
  workspacePath: string,
  sessionToken: string,
  generation: number
): Promise<true> {
  return withExclusiveWorkspaceMutation(workspacePath, async () => {
    const state = recoveryStateByWorkspace.get(workspaceIdentity(workspacePath))
    if (!state || state.sessionToken !== sessionToken) {
      throw new WorkspaceFileError('RECOVERY', 'Recovery session is stale')
    }
    if (generation < state.generation) return true
    const result = await clearEditorRecoveryUnsafe(workspacePath, generation)
    state.generation = generation
    return result
  })
}
