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
  return source.replace(
    pattern,
    (full: string, prefix: string, path: string, line: string | undefined, offset: number, whole: string) => {
      if (!accept(path)) return full
      const ref = line ? `${path}:${line}` : path
      if (!isLinkableWorkspacePath(ref)) return full
      const href = line ? `${VY_FILE_HREF_PREFIX}${path}:${line}` : `${VY_FILE_HREF_PREFIX}${path}`
      // The target of a link the agent wrote itself — `[the watcher](src/x.ts)`:
      // keep its label and point the target in-app instead of nesting a link.
      if (prefix === '(' && whole[offset - 1] === ']') return `${prefix}${href}`
      const label = line ? `${path}:${line}` : path
      return `${prefix}[${label}](${href})`
    }
  )
}

/**
 * An inline code span: a run of backticks, its text, the same run again. The
 * text may hold shorter runs (``a `b` c``).
 */
const CODE_SPAN_RE = /(`+)([\s\S]*?[^`])\1(?!`)/g

/**
 * A citation as the tool descriptions ask for one: `[[src/a.ts]]`,
 * `[[src/a.ts:12]]`, `[[src/a.ts:12-20]]`, `[[https://url]]`.
 */
const CITATION_RE = /\[\[([^[\]\n]+)\]\]/g
const CITED_FILE_RE = /^([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,10})(?::(\d+)(?:-\d+)?)?$/

/**
 * A citation as something to open: a workspace file at its (first) line, a
 * web page, or — a bare file name that names no folder, or any file when
 * there is nothing to open it with — code, so it reads like the paths around
 * it. Anything else (`[[1, 2]]`) stays as written.
 */
function formatCitations(prose: string, openFiles: boolean): string {
  return prose.replace(CITATION_RE, (full: string, target: string) => {
    const cited = target.trim()
    if (/^https?:\/\/\S+$/i.test(cited)) return `[${cited.replace(/^https?:\/\//i, '')}](${cited})`
    const file = CITED_FILE_RE.exec(cited)
    if (!file) return full
    const [, path, line] = file
    const ref = line ? `${path}:${line}` : path!
    const openable =
      openFiles && isLinkableWorkspacePath(ref) && (path!.includes('/') || isLikelyRootConfigFile(path!))
    return openable ? `[${cited}](${VY_FILE_HREF_PREFIX}${ref})` : `\`${cited}\``
  })
}

function autolinkPaths(prose: string): string {
  const withNested = autolinkPathMatch(formatCitations(prose, true), MULTI_SEGMENT_PATH_RE, () => true)
  return autolinkPathMatch(withNested, ROOT_CONFIG_PATH_RE, isLikelyRootConfigFile)
}

/** `rewrite` applied to the prose between inline code spans; the spans are kept as written. */
function outsideCodeSpans(source: string, rewrite: (prose: string) => string): string {
  let out = ''
  let last = 0
  for (const span of source.matchAll(CODE_SPAN_RE)) {
    out += rewrite(source.slice(last, span.index)) + span[0]
    last = span.index + span[0].length
  }
  return out + rewrite(source.slice(last))
}

/**
 * Turn bare `src/foo.ts` / `src/foo.ts:42` mentions and `[[src/foo.ts:42]]`
 * citations into markdown links (prose only). Code spans are left as written:
 * link syntax inside one renders as literal text — `npx vitest run
 * [tests/a.test](#vy-file:…).tsx` — and a span that is all path already opens
 * from its chip.
 */
export function autolinkWorkspacePathsInProse(source: string): string {
  return outsideCodeSpans(source, autolinkPaths)
}

/**
 * The citations alone, where nothing can open a file: each reads as code, a
 * web page still links. The tool descriptions ask every model for
 * `[[path:line]]`, so without this they showed with their brackets.
 */
export function formatCitationsInProse(source: string): string {
  return outsideCodeSpans(source, (prose) => formatCitations(prose, false))
}

export function parseVyFileHref(href: string | undefined): { path: string; line?: number } | null {
  if (!href?.startsWith(VY_FILE_HREF_PREFIX)) return null
  return parseLinkableWorkspacePath(href.slice(VY_FILE_HREF_PREFIX.length))
}
