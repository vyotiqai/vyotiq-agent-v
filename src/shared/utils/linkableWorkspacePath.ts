import { isSafeWorkspaceRelPath } from './workspacePath'

const FILE_EXT_RE = /^[A-Za-z0-9]{1,10}$/

const ROOT_LINKABLE_BASENAMES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'vitest.config.ts',
  'vite.config.ts',
  'eslint.config.js',
  'eslint.config.mjs',
  'prettier.config.js',
  'README.md',
  'AGENTS.md',
  'LICENSE',
  'LICENSE.md'
])

function isLikelyRootConfigFile(path: string): boolean {
  if (path.includes('/')) return false
  const lower = path.toLowerCase()
  if (ROOT_LINKABLE_BASENAMES.has(lower)) return true
  const dot = path.lastIndexOf('.')
  if (dot <= 0 || dot === path.length - 1) return false
  const name = path.slice(0, dot)
  const ext = path.slice(dot + 1)
  if (!FILE_EXT_RE.test(ext)) return false
  return /^(?:.*[-_.].*|.*config)$/i.test(name) && /^(json|ya?ml|toml|mdc?)$/i.test(ext)
}

/** Hash href prefix for in-app workspace file opens from markdown. */
export const VY_FILE_HREF_PREFIX = '#vy-file:'

export function parseLinkableWorkspacePath(
  raw: string
): { path: string; line?: number } | null {
  const trimmed = raw.trim()
  if (!trimmed || /\s/.test(trimmed)) return null

  let path = trimmed
  let line: number | undefined
  const colon = trimmed.lastIndexOf(':')
  if (colon > 0) {
    const suffix = trimmed.slice(colon + 1)
    if (/^\d+$/.test(suffix)) {
      path = trimmed.slice(0, colon)
      line = Number(suffix)
      if (!Number.isFinite(line) || line < 1) return null
    }
  }

  if (!isSafeWorkspaceRelPath(path)) return null
  const base = path.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return null
  const ext = base.slice(dot + 1)
  if (!FILE_EXT_RE.test(ext)) return null
  return { path, line }
}

export function isLinkableWorkspacePath(raw: string): boolean {
  return parseLinkableWorkspacePath(raw) !== null
}

export function parseOpenableAttachmentPath(
  name: string
): { path: string; line?: number } | null {
  const parsed = parseLinkableWorkspacePath(name)
  if (!parsed) return null
  if (parsed.path.includes('/') || isLikelyRootConfigFile(parsed.path)) return parsed
  return null
}

/** True when an attachment chip name is a workspace @-mention path (not a bare picker filename). */
export function isOpenableAttachmentPath(name: string): boolean {
  return parseOpenableAttachmentPath(name) !== null
}

const MULTI_SEGMENT_PATH_RE =
  /(^|[\s(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10})(?::(\d+))?(?=$|[\s).,;:!?])/gm

const ROOT_CONFIG_PATH_RE =
  /(^|[\s(])([A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,10})(?::(\d+))?(?=$|[\s).,;:!?])/gm

function autolinkPathMatch(
  source: string,
  pattern: RegExp,
  accept: (path: string) => boolean
): string {
  return source.replace(pattern, (full, prefix, path, line) => {
    if (!accept(path)) return full
    const ref = line ? `${path}:${line}` : path
    if (!isLinkableWorkspacePath(ref)) return full
    const href = line ? `${VY_FILE_HREF_PREFIX}${path}:${line}` : `${VY_FILE_HREF_PREFIX}${path}`
    const label = line ? `${path}:${line}` : path
    return `${prefix}[${label}](${href})`
  })
}

/** Turn bare `src/foo.ts` / `src/foo.ts:42` mentions into markdown links (prose only). */
export function autolinkWorkspacePathsInProse(source: string): string {
  const withNested = autolinkPathMatch(source, MULTI_SEGMENT_PATH_RE, () => true)
  return autolinkPathMatch(withNested, ROOT_CONFIG_PATH_RE, isLikelyRootConfigFile)
}

export function parseVyFileHref(href: string | undefined): { path: string; line?: number } | null {
  if (!href?.startsWith(VY_FILE_HREF_PREFIX)) return null
  return parseLinkableWorkspacePath(href.slice(VY_FILE_HREF_PREFIX.length))
}
