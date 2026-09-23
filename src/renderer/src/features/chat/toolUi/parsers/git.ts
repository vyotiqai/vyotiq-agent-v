import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'
import { countDiffLines, parseUnifiedDiff, type DiffLine } from './edit'

export type GitStatusFile = {
  status: string
  path: string
  added: number
  removed: number
}

export type GitStatusParsed = {
  branch: string
  clean: boolean
  message: string
  files: GitStatusFile[]
  added: number
  removed: number
}

export type GitDiffParsed = {
  path: string
  staged: boolean
  summary: string
  message: string
  lines: DiffLine[]
  added: number
  removed: number
}

/**
 * Parse git_status content from toolGitStatusAsync:
 *
 *   branch: main
 *   ...
 *   M          +2 -0  src/a.ts
 *   (clean)
 */
export function parseGitStatusData(tool: UiToolRow): GitStatusParsed {
  const content = (tool.content ?? '').trim()
  if (!content) {
    return { branch: '', clean: true, message: '', files: [], added: 0, removed: 0 }
  }
  if (content === 'Not a git repository' || /Git is not installed/i.test(content)) {
    return {
      branch: '',
      clean: true,
      message: content,
      files: [],
      added: 0,
      removed: 0
    }
  }

  let branch = ''
  let added = 0
  let removed = 0
  const files: GitStatusFile[] = []
  let clean = false

  for (const raw of content.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('branch:')) {
      branch = line.slice('branch:'.length).trim()
      continue
    }
    if (line === '(clean)') {
      clean = true
      continue
    }
    const totals = line.match(/^\+(\d+)\s+-(\d+)$/)
    if (totals) {
      added = Number(totals[1])
      removed = Number(totals[2])
      continue
    }
    const file = line.match(/^(\S+)\s+\+(\d+)\s+-(\d+)\s+(.+)$/)
    if (file) {
      files.push({
        status: file[1]!,
        added: Number(file[2]),
        removed: Number(file[3]),
        path: file[4]!.trim()
      })
    }
  }

  return {
    branch,
    clean: clean || files.length === 0,
    message: '',
    files,
    added,
    removed
  }
}

export type GitCommitParsed = {
  message: string
  hash: string
  summary: string
  committed: boolean | null
  pushed: boolean | null
  detail: string
}

/** Parse git_commit tool row: message from args/content; optional hash. */
export function parseGitCommitData(tool: UiToolRow): GitCommitParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const argMessage = typeof args?.message === 'string' ? args.message.trim() : ''
  const content = (tool.content ?? '').trim()
  const summary = tool.summary?.trim() || 'git commit'

  let message = argMessage
  let hash = ''
  let committed: boolean | null = null
  let pushed: boolean | null = null
  let detail = ''

  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const lower = line.toLowerCase()
    if (lower.startsWith('message:')) {
      const value = line.slice('message:'.length).trim()
      if (value) message = value
      continue
    }
    if (lower.startsWith('hash:')) {
      hash = line.slice('hash:'.length).trim()
      continue
    }
    if (lower.startsWith('committed:')) {
      committed = lower.slice('committed:'.length).trim() === 'true'
      continue
    }
    if (lower.startsWith('pushed:')) {
      pushed = lower.slice('pushed:'.length).trim() === 'true'
      continue
    }
    if (/^[0-9a-f]{7,40}$/i.test(line)) {
      hash = line
      continue
    }
    if (!detail) detail = line
  }

  return {
    message,
    hash,
    summary,
    committed,
    pushed,
    detail
  }
}

/** Prefer args.path; else recover from unified / git headers for Material icons. */
export function pathFromUnifiedDiffContent(content: string): string {
  if (!content.trim()) return ''
  const plusPlus = /^\+\+\+\s+(?:b\/)?(.+)$/m.exec(content)
  if (plusPlus?.[1]) {
    const p = plusPlus[1].split('\t')[0]!.trim()
    if (p && p !== '/dev/null') return p.replace(/^\.\//, '')
  }
  const gitLine = /^diff --git a\/.+ b\/(.+)$/m.exec(content)
  if (gitLine?.[1]) return gitLine[1].trim()
  const minusMinus = /^---\s+(?:a\/)?(.+)$/m.exec(content)
  if (minusMinus?.[1]) {
    const p = minusMinus[1].split('\t')[0]!.trim()
    if (p && p !== '/dev/null') return p.replace(/^\.\//, '')
  }
  return ''
}

/** Parse git_diff tool row: unified diff in content + path/staged from args. */
export function parseGitDiffData(tool: UiToolRow): GitDiffParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const fromArgs = typeof args?.path === 'string' ? args.path.trim() : ''
  const content = tool.content ?? ''
  const path = fromArgs || pathFromUnifiedDiffContent(content)
  const staged = args?.staged === true
  const summary = tool.summary?.trim() || (path ? `git diff ${path}` : staged ? 'git diff --staged' : 'git diff')

  if (!content.trim() || content === 'Not a git repository') {
    return {
      path,
      staged,
      summary,
      message: content.trim() || 'No diff',
      lines: [],
      added: 0,
      removed: 0
    }
  }

  // Match the Changes tab / DiffPreview caps — avoid allocating full 100k-char patches.
  const lines = parseUnifiedDiff(content, 201)
  const { added, removed } = countDiffLines(content)
  return {
    path,
    staged,
    summary,
    message: lines.length === 0 ? content : '',
    lines,
    added,
    removed
  }
}
