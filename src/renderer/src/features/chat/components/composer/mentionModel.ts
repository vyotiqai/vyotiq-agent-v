import type { SlashCommandKind } from '@shared/ipc'
import { isSafeWorkspaceRelPath, isCuratedDocPath } from '@shared/workspacePath'
import { basename } from '@shared/utils/path'

/** Private-use markers so chips survive draft persistence as plain strings. */
export const MENTION_START = '\uFFF9'
export const MENTION_END = '\uFFFA'

export type DiagnosticsKind = 'typecheck' | 'lint'

export type ComposerMention =
  | { kind: 'file'; path: string }
  | { kind: 'docs'; path: string }
  | { kind: 'rule'; path: string }
  | { kind: 'lints'; diagnosticsKind: DiagnosticsKind }
  | { kind: 'branch'; branch?: string | null }
  | { kind: 'browser' }
  | { kind: 'chat'; runId: string; title: string }
  | {
      kind: 'slash'
      slashKind: SlashCommandKind
      trigger: string
      commandId?: string
    }

const SLASH_KINDS = new Set<SlashCommandKind>([
  'builtin',
  'skill',
  'workspace',
  'rule',
  'mcp'
])

function isSlashKind(value: string): value is SlashCommandKind {
  return SLASH_KINDS.has(value as SlashCommandKind)
}

export type ComposerSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; mention: ComposerMention }

export type MentionMenuView = 'root' | 'files' | 'chats' | 'docs' | 'rules'

export type MentionMenuItem =
  | {
      id: 'branch'
      kind: 'branch'
      label: string
      subtitle: string
    }
  | {
      id: 'browser'
      kind: 'browser'
      label: string
      subtitle: string
    }
  | {
      id: 'lints-typecheck' | 'lints-lint'
      kind: 'lints'
      diagnosticsKind: DiagnosticsKind
      label: string
      subtitle: string
    }
  | {
      id: 'files' | 'chats' | 'docs' | 'rules'
      kind: 'nav'
      view: Exclude<MentionMenuView, 'root'>
      label: string
      subtitle?: string
    }
  | {
      id: string
      kind: 'file'
      path: string
      label: string
      subtitle: string
    }
  | {
      id: string
      kind: 'docs'
      path: string
      label: string
      subtitle: string
    }
  | {
      id: string
      kind: 'rule'
      path: string
      label: string
      subtitle: string
    }
  | {
      id: string
      kind: 'chat'
      runId: string
      label: string
      subtitle: string
    }
  | {
      id: 'show-more'
      kind: 'show-more'
      label: string
      remaining: number
    }

export { isSafeWorkspaceRelPath, isCuratedDocPath }

/** Strip Cursor-style YAML frontmatter for rule body injection. */
export function parseRuleFrontmatterBody(raw: string): string {
  const trimmed = raw.replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('---')) return trimmed.trim()
  const end = trimmed.indexOf('\n---', 3)
  if (end < 0) return trimmed.trim()
  return trimmed.slice(end + 4).replace(/^\r?\n/, '').trim()
}

const AUTO_INJECT_ROOT_RULES = new Set(['AGENTS.md', 'CLAUDE.md', '.cursorrules'])

/**
 * True when this rule path is already injected into the system prompt
 * (root instruction files, or Cursor rules without `alwaysApply: false`).
 */
export function isAutoInjectedWorkspaceRule(path: string, raw: string): boolean {
  const norm = path.replace(/\\/g, '/')
  if (AUTO_INJECT_ROOT_RULES.has(norm) || AUTO_INJECT_ROOT_RULES.has(basenamePath(norm))) {
    return true
  }
  const trimmed = raw.replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('---')) {
    // No frontmatter in rule dirs ⇒ treated as auto-inject (matches main rules.ts).
    return true
  }
  const end = trimmed.indexOf('\n---', 3)
  if (end < 0) return true
  const fmBlock = trimmed.slice(3, end)
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^alwaysApply\s*:\s*(.*)$/i)
    if (!m) continue
    const value = m[1]!.trim()
    if (/^(false|no|0)$/i.test(value)) return false
    return true
  }
  return true
}

/** @deprecated Prefer `@shared/utils/path` `basename` — kept as a stable export for callers. */
export function basenamePath(path: string): string {
  return basename(path)
}

export function parentPath(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? norm.slice(0, i) : ''
}

export function pathSegments(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
}

export function mentionLabel(mention: ComposerMention): string {
  switch (mention.kind) {
    case 'file':
    case 'docs':
      return basenamePath(mention.path)
    case 'rule':
      return basenamePath(mention.path)
    case 'lints':
      return mention.diagnosticsKind === 'lint' ? 'Lint' : 'Typecheck'
    case 'branch':
      return mention.branch?.trim() || 'Branch'
    case 'browser':
      return 'Browser'
    case 'chat':
      return mention.title.trim() || mention.runId.slice(0, 8)
    case 'slash':
      return mention.trigger.trim() || mention.slashKind
    default: {
      const _exhaustive: never = mention
      return _exhaustive
    }
  }
}

function encodePayload(mention: ComposerMention): string {
  switch (mention.kind) {
    case 'file':
      return `file:${mention.path.replace(/\\/g, '/')}`
    case 'docs':
      return `docs:${mention.path.replace(/\\/g, '/')}`
    case 'rule':
      return `rule:${mention.path.replace(/\\/g, '/')}`
    case 'lints':
      return `lints:${mention.diagnosticsKind}`
    case 'branch':
      return mention.branch ? `branch:${mention.branch}` : 'branch'
    case 'browser':
      return 'browser'
    case 'chat':
      return `chat:${mention.runId}|${encodeURIComponent(mention.title)}`
    case 'slash': {
      const trigger = mention.trigger.trim()
      const head = `slash:${mention.slashKind}:${encodeURIComponent(trigger)}`
      if (!mention.commandId) return head
      return `${head}|${encodeURIComponent(mention.commandId)}`
    }
    default: {
      const _exhaustive: never = mention
      return _exhaustive
    }
  }
}

function decodeSlashPayload(raw: string): Extract<ComposerMention, { kind: 'slash' }> | null {
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }

  // Legacy skill: payloads from earlier drafts.
  if (raw.startsWith('skill:')) {
    const rest = raw.slice('skill:'.length)
    const bar = rest.indexOf('|')
    if (bar < 0) {
      const trigger = decode(rest.trim())
      if (!trigger) return null
      return { kind: 'slash', slashKind: 'skill', trigger }
    }
    const trigger = decode(rest.slice(0, bar).trim())
    if (!trigger) return null
    const commandId = decode(rest.slice(bar + 1).trim()) || undefined
    return {
      kind: 'slash',
      slashKind: 'skill',
      trigger,
      ...(commandId ? { commandId } : {})
    }
  }

  if (!raw.startsWith('slash:')) return null
  const rest = raw.slice('slash:'.length)
  const firstColon = rest.indexOf(':')
  if (firstColon <= 0) return null
  const slashKindRaw = rest.slice(0, firstColon)
  if (!isSlashKind(slashKindRaw)) return null
  const afterKind = rest.slice(firstColon + 1)
  const bar = afterKind.indexOf('|')
  if (bar < 0) {
    const trigger = decode(afterKind.trim())
    if (!trigger) return null
    return { kind: 'slash', slashKind: slashKindRaw, trigger }
  }
  const trigger = decode(afterKind.slice(0, bar).trim())
  if (!trigger) return null
  const commandId = decode(afterKind.slice(bar + 1).trim()) || undefined
  return {
    kind: 'slash',
    slashKind: slashKindRaw,
    trigger,
    ...(commandId ? { commandId } : {})
  }
}

export function decodeMentionPayload(payload: string): ComposerMention | null {
  const raw = payload.trim()
  if (!raw) return null
  if (raw === 'browser') return { kind: 'browser' }
  if (raw === 'branch' || raw.startsWith('branch:')) {
    const branch = raw === 'branch' ? null : raw.slice('branch:'.length)
    return { kind: 'branch', branch }
  }
  if (raw === 'lints' || raw.startsWith('lints:')) {
    const kind = raw === 'lints' ? 'typecheck' : raw.slice('lints:'.length)
    if (kind !== 'typecheck' && kind !== 'lint') return null
    return { kind: 'lints', diagnosticsKind: kind }
  }
  if (raw.startsWith('file:')) {
    const path = raw.slice('file:'.length).trim().replace(/\\/g, '/')
    if (!isSafeWorkspaceRelPath(path)) return null
    return { kind: 'file', path }
  }
  if (raw.startsWith('docs:')) {
    const path = raw.slice('docs:'.length).trim().replace(/\\/g, '/')
    if (!isSafeWorkspaceRelPath(path)) return null
    return { kind: 'docs', path }
  }
  if (raw.startsWith('rule:')) {
    const path = raw.slice('rule:'.length).trim().replace(/\\/g, '/')
    if (!isSafeWorkspaceRelPath(path)) return null
    return { kind: 'rule', path }
  }
  if (raw.startsWith('chat:')) {
    const rest = raw.slice('chat:'.length)
    const bar = rest.indexOf('|')
    if (bar < 0) {
      const runId = rest.trim()
      if (!runId) return null
      return { kind: 'chat', runId, title: runId }
    }
    const runId = rest.slice(0, bar).trim()
    if (!runId) return null
    let title = rest.slice(bar + 1)
    try {
      title = decodeURIComponent(title)
    } catch {
      // keep raw
    }
    return { kind: 'chat', runId, title: title || runId }
  }
  const slash = decodeSlashPayload(raw)
  if (slash) return slash
  return null
}

export function mentionMarker(mention: ComposerMention): string {
  return `${MENTION_START}${encodePayload(mention)}${MENTION_END}`
}

/** Split draft (with markers) into text/mention segments. */
export function parseComposerDocument(raw: string): ComposerSegment[] {
  if (!raw) return [{ type: 'text', value: '' }]
  const segments: ComposerSegment[] = []
  let i = 0
  while (i < raw.length) {
    const start = raw.indexOf(MENTION_START, i)
    if (start < 0) {
      segments.push({ type: 'text', value: raw.slice(i) })
      break
    }
    if (start > i) {
      segments.push({ type: 'text', value: raw.slice(i, start) })
    }
    const end = raw.indexOf(MENTION_END, start + MENTION_START.length)
    if (end < 0) {
      segments.push({ type: 'text', value: raw.slice(start) })
      break
    }
    const payload = raw.slice(start + MENTION_START.length, end)
    const mention = decodeMentionPayload(payload)
    if (mention) {
      segments.push({ type: 'mention', mention })
    } else {
      segments.push({ type: 'text', value: raw.slice(start, end + MENTION_END.length) })
    }
    i = end + MENTION_END.length
  }
  if (segments.length === 0) return [{ type: 'text', value: '' }]
  return segments
}

export function serializeComposerDocument(segments: ComposerSegment[]): string {
  return segments
    .map((seg) => {
      if (seg.type === 'text') return seg.value
      return mentionMarker(seg.mention)
    })
    .join('')
}

/** Plain text for empty-check / slash parse — markers become readable stubs. */
export function composerDocumentPlainText(raw: string): string {
  return parseComposerDocument(raw)
    .map((seg) => {
      if (seg.type === 'text') return seg.value
      if (seg.mention.kind === 'slash') return `/${mentionLabel(seg.mention)}`
      return `@${mentionLabel(seg.mention)}`
    })
    .join('')
}

/**
 * Detect a slash-command chip in the composer draft for slash-style submit.
 * Returns the first slash chip and the draft with slash chips removed
 * (other @mentions preserved for resolve-on-send).
 */
export function findSlashChipSubmit(raw: string): {
  trigger: string
  commandId: string | null
  slashKind: SlashCommandKind
  trailingRaw: string
} | null {
  const segments = parseComposerDocument(raw)
  const slashSeg = segments.find(
    (seg): seg is { type: 'mention'; mention: Extract<ComposerMention, { kind: 'slash' }> } =>
      seg.type === 'mention' && seg.mention.kind === 'slash'
  )
  if (!slashSeg) return null
  const trailingRaw = serializeComposerDocument(
    segments.filter((seg) => !(seg.type === 'mention' && seg.mention.kind === 'slash'))
  )
  return {
    trigger: slashSeg.mention.trigger,
    commandId: slashSeg.mention.commandId ?? null,
    slashKind: slashSeg.mention.slashKind,
    trailingRaw
  }
}

export function extractMentions(raw: string): ComposerMention[] {
  return parseComposerDocument(raw)
    .filter((s): s is { type: 'mention'; mention: ComposerMention } => s.type === 'mention')
    .map((s) => s.mention)
}

export function hasComposerContent(raw: string): boolean {
  return composerDocumentPlainText(raw).trim().length > 0 || extractMentions(raw).length > 0
}

/**
 * Insert a mention chip, replacing the active `@token` range.
 * Returns the next document string and caret index (after the chip).
 */
export function insertMentionAtToken(
  text: string,
  tokenStart: number,
  tokenEnd: number,
  mention: ComposerMention
): { nextText: string; nextCursor: number } {
  const marker = mentionMarker(mention)
  const nextText = text.slice(0, tokenStart) + marker + text.slice(tokenEnd)
  return { nextText, nextCursor: tokenStart + marker.length }
}

/** Active `@query` token at caret (line start or after whitespace); ignores inside markers. */
export function findActiveMentionToken(
  text: string,
  cursor: number
): { start: number; end: number; query: string } | null {
  const pos = Math.max(0, Math.min(cursor, text.length))

  // Caret inside a marker → no active @ token.
  let scan = 0
  while (scan < text.length) {
    const s = text.indexOf(MENTION_START, scan)
    if (s < 0) break
    const e = text.indexOf(MENTION_END, s + MENTION_START.length)
    if (e < 0) break
    if (pos > s && pos < e + MENTION_END.length) return null
    scan = e + MENTION_END.length
  }

  let start = pos
  while (start > 0) {
    const ch = text[start - 1]
    if (ch === '\n' || ch === ' ' || ch === '\t') break
    if (ch === MENTION_END) break
    start -= 1
  }
  if (text[start] !== '@') return null
  if (start > 0) {
    const before = text[start - 1]
    if (
      before !== '\n' &&
      before !== ' ' &&
      before !== '\t' &&
      before !== MENTION_END
    ) {
      return null
    }
  }
  let end = start + 1
  while (end < text.length) {
    const ch = text[end]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === MENTION_START) break
    end += 1
  }
  if (pos > end) return null
  return {
    start,
    end,
    query: text.slice(start + 1, end)
  }
}

export function buildRootMentionItems(opts: {
  query: string
  recentFiles: string[]
  matchingFiles: string[]
  /** When false, omit codebase file rows and Files & Folders (no selected workspace). */
  includeCodebase?: boolean
  branchName?: string | null
}): MentionMenuItem[] {
  const q = opts.query.trim().toLowerCase()
  const items: MentionMenuItem[] = []
  const includeCodebase = opts.includeCodebase !== false

  const branchOk = !q || 'branch'.includes(q) || 'diff'.includes(q)
  const browserOk = !q || 'browser'.includes(q) || 'web'.includes(q)
  const lintsOk =
    includeCodebase &&
    (!q || 'lint'.includes(q) || 'lints'.includes(q) || 'typecheck'.includes(q) || 'diag'.includes(q))
  const filesNavOk =
    includeCodebase &&
    (!q || 'files'.includes(q) || 'folders'.includes(q) || 'file'.includes(q) || 'codebase'.includes(q))
  const docsNavOk =
    includeCodebase && (!q || 'docs'.includes(q) || 'doc'.includes(q) || 'readme'.includes(q))
  const rulesNavOk =
    includeCodebase && (!q || 'rules'.includes(q) || 'rule'.includes(q) || 'agents'.includes(q))
  const chatsNavOk = !q || 'past'.includes(q) || 'chats'.includes(q) || 'chat'.includes(q)

  // Context → Files → Browse (see buildMentionRootSections).
  if (branchOk) {
    const branch = opts.branchName?.trim()
    items.push({
      id: 'branch',
      kind: 'branch',
      label: 'Branch',
      subtitle: branch ? `Diff for ${branch}` : 'Current branch diff'
    })
  }
  if (browserOk) {
    items.push({
      id: 'browser',
      kind: 'browser',
      label: 'Browser',
      subtitle: 'Prefer browser tools this turn'
    })
  }
  if (lintsOk) {
    items.push({
      id: 'lints-typecheck',
      kind: 'lints',
      diagnosticsKind: 'typecheck',
      label: 'Typecheck',
      subtitle: 'Attach typecheck errors'
    })
    items.push({
      id: 'lints-lint',
      kind: 'lints',
      diagnosticsKind: 'lint',
      label: 'Lint',
      subtitle: 'Attach lint errors'
    })
  }

  if (includeCodebase) {
    const filePool = [...opts.recentFiles, ...opts.matchingFiles]
    const seen = new Set<string>()
    for (const path of filePool) {
      const norm = path.replace(/\\/g, '/')
      if (!isSafeWorkspaceRelPath(norm)) continue
      if (seen.has(norm)) continue
      if (q && !norm.toLowerCase().includes(q) && !basenamePath(norm).toLowerCase().includes(q)) {
        continue
      }
      seen.add(norm)
      const parent = parentPath(norm)
      items.push({
        id: `file:${norm}`,
        kind: 'file',
        path: norm,
        label: basenamePath(norm),
        subtitle: parent || 'Workspace root'
      })
      if (seen.size >= 3) break
    }
  }

  if (filesNavOk) {
    items.push({
      id: 'files',
      kind: 'nav',
      view: 'files',
      label: 'Files & Folders',
      subtitle: 'Browse the workspace'
    })
  }
  if (docsNavOk) {
    items.push({
      id: 'docs',
      kind: 'nav',
      view: 'docs',
      label: 'Docs',
      subtitle: 'README and project docs'
    })
  }
  if (rulesNavOk) {
    items.push({
      id: 'rules',
      kind: 'nav',
      view: 'rules',
      label: 'Rules',
      subtitle: 'Agent rules'
    })
  }
  if (chatsNavOk) {
    items.push({
      id: 'chats',
      kind: 'nav',
      view: 'chats',
      label: 'Past Chats',
      subtitle: 'Earlier conversations'
    })
  }

  return items
}

export function buildFileMentionItems(
  paths: string[],
  total: number,
  shown: number
): MentionMenuItem[] {
  const safe = paths
    .map((path) => path.replace(/\\/g, '/'))
    .filter(isSafeWorkspaceRelPath)
  const items: MentionMenuItem[] = safe.map((norm) => {
    const parent = parentPath(norm)
    return {
      id: `file:${norm}`,
      kind: 'file' as const,
      path: norm,
      label: basenamePath(norm),
      subtitle: parent || 'Workspace root'
    }
  })
  const remaining = Math.max(0, total - shown)
  if (remaining > 0) {
    items.push({
      id: 'show-more',
      kind: 'show-more',
      label: `Show ${remaining} more`,
      remaining
    })
  }
  return items
}

export function buildDocsMentionItems(paths: string[]): MentionMenuItem[] {
  return paths
    .map((path) => path.replace(/\\/g, '/'))
    .filter(isSafeWorkspaceRelPath)
    .map((norm) => {
      const parent = parentPath(norm)
      return {
        id: `docs:${norm}`,
        kind: 'docs' as const,
        path: norm,
        label: basenamePath(norm),
        subtitle: parent || 'Workspace root'
      }
    })
}

export function buildRuleMentionItems(
  rules: Array<{ path: string; description?: string; alwaysApply: boolean }>
): MentionMenuItem[] {
  return rules
    .map((rule) => ({
      ...rule,
      path: rule.path.replace(/\\/g, '/')
    }))
    .filter((rule) => isSafeWorkspaceRelPath(rule.path))
    .map((rule) => ({
      id: `rule:${rule.path}`,
      kind: 'rule' as const,
      path: rule.path,
      label: basenamePath(rule.path),
      subtitle:
        rule.description?.trim() ||
        (rule.alwaysApply ? 'Always applied' : 'Requestable rule')
    }))
}

export function buildChatMentionItems(
  runs: Array<{ runId: string; goal?: string; updatedAt: string }>
): MentionMenuItem[] {
  return runs.map((run) => {
    const title = run.goal?.trim() || run.runId
    return {
      id: `chat:${run.runId}`,
      kind: 'chat' as const,
      runId: run.runId,
      label: title,
      subtitle: formatRelativeTime(run.updatedAt)
    }
  })
}

function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const diff = Date.now() - t
  const mins = Math.round(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}
