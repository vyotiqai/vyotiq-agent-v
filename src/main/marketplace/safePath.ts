import { app } from 'electron'
import { existsSync, lstatSync, realpathSync } from 'fs'
import { basename, dirname, join, isAbsolute, relative, resolve } from 'path'
import { isSafeWorkspaceRelPath } from '../../shared/utils/workspacePath'
import { userDataRoot } from '../storage/paths'

/** Marketplace package id / version / single path segment — no traversal. */
const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

function packagesRoot(): string {
  return join(userDataRoot(), 'marketplace', 'packages')
}

function bundledRoot(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'marketplace')
  }
  return join(app.getAppPath(), 'resources', 'marketplace')
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function isInsideRoot(resolved: string, realRoot: string): boolean {
  const rootKey = pathKey(realRoot)
  const resolvedKey = pathKey(resolved)
  const sep = process.platform === 'win32' ? '\\' : '/'
  return resolvedKey === rootKey || resolvedKey.startsWith(rootKey + sep)
}

export function isSafeMarketplaceSegment(segment: string): boolean {
  const t = segment.trim()
  if (!t || t === '.' || t === '..') return false
  if (t.includes('/') || t.includes('\\') || t.includes('\0')) return false
  return SEGMENT_RE.test(t)
}

export function assertSafeMarketplaceSegment(segment: string, label = 'segment'): string {
  const t = segment.trim()
  if (!isSafeMarketplaceSegment(t)) {
    throw new Error(`Invalid marketplace ${label}: ${segment}`)
  }
  return t
}

/**
 * Resolve `...segments` under `marketplace/packages` and reject escapes.
 */
export function resolveInsideMarketplacePackages(...segments: string[]): string {
  const root = resolve(packagesRoot())
  const safe = segments.map((s) => assertSafeMarketplaceSegment(s, 'path segment'))
  const dir = resolve(root, ...safe)
  const rel = relative(root, dir)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Marketplace path escapes packages root: ${segments.join('/')}`)
  }
  return dir
}

/**
 * Resolve a relative path under an installed package root (plugin mcp/skills/rules).
 * Rejects string escapes and symlink targets outside the package root.
 */
export function resolveInsidePackageRoot(packageRoot: string, relPath: string): string {
  const root = resolve(packageRoot)
  const realRoot = existsSync(root) ? realpathSync(root) : root
  const rel = relPath.trim().replace(/\\/g, '/')
  if (!isSafeWorkspaceRelPath(rel)) {
    throw new Error(`Unsafe package-relative path: ${relPath}`)
  }
  const abs = resolve(root, ...rel.split('/'))
  const outRel = relative(root, abs)
  if (!outRel || outRel.startsWith('..') || isAbsolute(outRel)) {
    throw new Error(`Path escapes package root: ${relPath}`)
  }

  if (existsSync(abs)) {
    if (lstatSync(abs).isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed in package paths: ${relPath}`)
    }
    const real = realpathSync(abs)
    if (!isInsideRoot(real, realRoot)) {
      throw new Error(`Path escapes package root: ${relPath}`)
    }
    return real
  }

  // New / missing file — walk up to nearest existing ancestor (Skill tool only reads existing).
  const tail: string[] = []
  let probe = abs
  while (!existsSync(probe)) {
    tail.unshift(basename(probe))
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  if (!existsSync(probe)) {
    return abs
  }
  if (lstatSync(probe).isSymbolicLink()) {
    throw new Error(`Symlinks are not allowed in package paths: ${relPath}`)
  }
  const realBase = realpathSync(probe)
  if (!isInsideRoot(realBase, realRoot)) {
    throw new Error(`Path escapes package root: ${relPath}`)
  }
  return tail.length ? join(realBase, ...tail) : realBase
}

/** Resolve under bundled resources/marketplace with containment. */
export function resolveInsideBundledMarketplace(relPath: string): string {
  const root = resolve(bundledRoot())
  const rel = relPath.trim().replace(/\\/g, '/')
  if (!isSafeWorkspaceRelPath(rel)) {
    throw new Error(`Unsafe bundled marketplace path: ${relPath}`)
  }
  const abs = resolve(root, ...rel.split('/'))
  const outRel = relative(root, abs)
  if (!outRel || outRel.startsWith('..') || isAbsolute(outRel)) {
    throw new Error(`Bundled path escapes marketplace root: ${relPath}`)
  }
  return abs
}

export function assertSafePackagePath(packagePath: string): string {
  const rel = packagePath.trim().replace(/\\/g, '/')
  if (!isSafeWorkspaceRelPath(rel)) {
    throw new Error(`Unsafe marketplace packagePath: ${packagePath}`)
  }
  const parts = rel.split('/')
  if (parts.length !== 2 || !parts.every(isSafeMarketplaceSegment)) {
    throw new Error(`Invalid marketplace packagePath: ${packagePath}`)
  }
  return parts.join('/')
}
