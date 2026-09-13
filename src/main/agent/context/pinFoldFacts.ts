import { normalizeWorkspaceRelPath, type FoldFacts } from './foldFacts'
import { FILE_COVERAGE_MAX_NEEDED, factMentionedInText, pathMentionedInText } from './verifyCompaction'

/** Structured sidecar stored on CompactionRecord so assemble can inject facts after the narrative is capped. */
export type PinnedFoldFacts = {
  files: string[]
  wroteFiles: string[]
  decisions: string[]
  todos: string[]
  doneWhen: string[]
  constraints: string[]
  contractGoal?: string
}

const PINNED_HEADING = 'Pinned Facts'
const PINNED_APPENDIX_RE = /\n*##\s+Pinned Facts\s*\n[\s\S]*$/i

const CAPS = {
  files: 64,
  wroteFiles: 64,
  decisions: 32,
  todos: 32,
  doneWhen: 32,
  constraints: 32
} as const

function uniqueStrings(values: readonly string[], cap: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = raw.replace(/\s+/g, ' ').trim().slice(0, 240)
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= cap) break
  }
  return out
}

function uniquePaths(values: readonly string[], cap: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const path = normalizeWorkspaceRelPath(raw)
    if (!path) continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
    if (out.length >= cap) break
  }
  return out
}

function emptyFoldFacts(): FoldFacts {
  return {
    files: [],
    wroteFiles: [],
    decisions: [],
    todos: [],
    doneWhen: [],
    constraints: []
  }
}

export function pinnedFactsToFoldFacts(pinned?: PinnedFoldFacts | null): FoldFacts {
  if (!pinned) return emptyFoldFacts()
  return {
    files: [...pinned.files],
    wroteFiles: [...pinned.wroteFiles],
    decisions: [...pinned.decisions],
    todos: [...pinned.todos],
    doneWhen: [...pinned.doneWhen],
    constraints: [...pinned.constraints],
    ...(pinned.contractGoal ? { contractGoal: pinned.contractGoal } : {})
  }
}

export function foldFactsToPinned(facts: FoldFacts): PinnedFoldFacts {
  const wroteFiles = uniquePaths(facts.wroteFiles, CAPS.wroteFiles)
  const wroteKeys = new Set(wroteFiles.map((path) => path.toLowerCase()))
  const inspect = uniquePaths(
    facts.files.filter((path) => !wroteKeys.has(normalizeWorkspaceRelPath(path).toLowerCase())),
    FILE_COVERAGE_MAX_NEEDED
  )
  return {
    files: uniquePaths([...wroteFiles, ...inspect], CAPS.files),
    wroteFiles,
    decisions: uniqueStrings(facts.decisions, CAPS.decisions),
    todos: uniqueStrings(facts.todos, CAPS.todos),
    doneWhen: uniqueStrings(facts.doneWhen, CAPS.doneWhen),
    constraints: uniqueStrings(facts.constraints ?? [], CAPS.constraints),
    ...(facts.contractGoal?.trim()
      ? { contractGoal: facts.contractGoal.replace(/\s+/g, ' ').trim().slice(0, 240) }
      : {})
  }
}

export function mergeFoldFacts(base: FoldFacts | undefined, extra: FoldFacts): FoldFacts {
  const left = base ?? emptyFoldFacts()
  return {
    files: uniquePaths([...left.files, ...extra.files], CAPS.files),
    wroteFiles: uniquePaths([...left.wroteFiles, ...extra.wroteFiles], CAPS.wroteFiles),
    decisions: uniqueStrings([...left.decisions, ...extra.decisions], CAPS.decisions),
    todos: uniqueStrings([...left.todos, ...extra.todos], CAPS.todos),
    doneWhen: uniqueStrings([...left.doneWhen, ...extra.doneWhen], CAPS.doneWhen),
    constraints: uniqueStrings(
      [...(left.constraints ?? []), ...(extra.constraints ?? [])],
      CAPS.constraints
    ),
    ...(extra.contractGoal?.trim()
      ? { contractGoal: extra.contractGoal.replace(/\s+/g, ' ').trim().slice(0, 240) }
      : left.contractGoal?.trim()
        ? { contractGoal: left.contractGoal.replace(/\s+/g, ' ').trim().slice(0, 240) }
        : {})
  }
}

function stripPinnedAppendix(summary: string): string {
  return summary.replace(PINNED_APPENDIX_RE, '').trimEnd()
}

function missingLines(facts: FoldFacts, summary: string): string[] {
  const pinned = foldFactsToPinned(facts)
  const lines: string[] = []
  if (pinned.contractGoal && !factMentionedInText(pinned.contractGoal, summary)) {
    lines.push(`- Goal: ${pinned.contractGoal}`)
  }
  for (const path of pinned.wroteFiles) {
    if (!pathMentionedInText(path, summary)) lines.push(`- Wrote: \`${path}\``)
  }
  for (const path of pinned.files) {
    if (pinned.wroteFiles.some((wrote) => wrote.toLowerCase() === path.toLowerCase())) continue
    if (!pathMentionedInText(path, summary)) lines.push(`- Inspected: \`${path}\``)
  }
  for (const decision of pinned.decisions) {
    if (!factMentionedInText(decision, summary)) lines.push(`- Decision: ${decision}`)
  }
  for (const constraint of pinned.constraints) {
    if (!factMentionedInText(constraint, summary)) lines.push(`- Constraint: ${constraint}`)
  }
  for (const todo of pinned.todos) {
    if (!factMentionedInText(todo, summary)) lines.push(`- Todo: ${todo}`)
  }
  for (const line of pinned.doneWhen) {
    if (!factMentionedInText(line, summary)) lines.push(`- Done when: ${line}`)
  }
  return lines
}

/**
 * Splice missing extractive facts into a trailing appendix. No-op when the
 * summary already cites every pinned fact. Invented Files Touched paths are
 * left in place so the verifier can still reject hallucinations.
 */
export function pinFoldFacts(summary: string, facts: FoldFacts): string {
  const body = stripPinnedAppendix(summary)
  const lines = missingLines(facts, body)
  if (lines.length === 0) return body
  return `${body}\n\n## ${PINNED_HEADING}\n${lines.join('\n')}`
}

/** Compact sidecar for assemble — reserved budget, not subject to narrative tail-cap. */
export function formatPinnedFacts(pinned?: PinnedFoldFacts | null): string {
  if (!pinned) return ''
  const lines: string[] = ['Pinned fold facts (verbatim; do not drop):']
  if (pinned.contractGoal) lines.push(`Goal: ${pinned.contractGoal}`)
  if (pinned.wroteFiles.length > 0) {
    lines.push(`Wrote: ${pinned.wroteFiles.map((path) => `\`${path}\``).join(', ')}`)
  }
  const inspect = pinned.files.filter(
    (path) => !pinned.wroteFiles.some((wrote) => wrote.toLowerCase() === path.toLowerCase())
  )
  if (inspect.length > 0) {
    lines.push(`Inspected: ${inspect.map((path) => `\`${path}\``).join(', ')}`)
  }
  for (const decision of pinned.decisions) lines.push(`Decision: ${decision}`)
  for (const constraint of pinned.constraints) lines.push(`Constraint: ${constraint}`)
  for (const todo of pinned.todos) lines.push(`Todo: ${todo}`)
  for (const line of pinned.doneWhen) lines.push(`Done when: ${line}`)
  return lines.length > 1 ? lines.join('\n') : ''
}
