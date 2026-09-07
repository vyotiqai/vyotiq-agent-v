import {
  DEFAULT_PLAN_STUB,
  isPlanSectionPromptLine,
  isPlanStubHintLine,
  planSectionKey
} from './planStub'

/** Minimum cleaned body line length to count as drafted content. */
export const PLAN_BODY_MIN_CHARS = 8

const DONE_WHEN_KEYS = new Set([
  'done when',
  'success criteria',
  'verification',
  'acceptance criteria'
])

function isHorizontalRule(line: string): boolean {
  return /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())
}

function isFenceOnly(line: string): boolean {
  return /^`{3,}/.test(line.trim())
}

function stripMarkdownChrome(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*{1,2}|\*{1,2}$/g, '')
    .replace(/^_{1,2}|_{1,2}$/g, '')
    .replace(/^[-*+]\s*\[[ xX]\]\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim()
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}(\s|$)/.test(line.trim())
}

/** Substantive plan body lines for readiness checks. */
export function planDraftBodyLines(content: string): string[] {
  const out: string[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (isHeadingLine(line)) continue
    if (isHorizontalRule(line)) continue
    if (isFenceOnly(line)) continue
    if (isPlanStubHintLine(line) || isPlanSectionPromptLine(line)) continue
    const cleaned = stripMarkdownChrome(line)
    if (cleaned.length < PLAN_BODY_MIN_CHARS) continue
    out.push(cleaned)
  }
  return out
}

function parseH2Bodies(markdown: string): Map<string, string> {
  const buckets = new Map<string, string[]>()
  let current: string | null = null
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = raw.match(/^#{2,3}\s+(.+?)\s*$/)
    if (heading?.[1]) {
      current = planSectionKey(heading[1])
      if (!buckets.has(current)) buckets.set(current, [])
      continue
    }
    if (current) buckets.get(current)!.push(raw)
  }
  const out = new Map<string, string>()
  for (const [key, lines] of buckets) out.set(key, lines.join('\n'))
  return out
}

/** Body of Done when / Success criteria, if drafted. */
export function extractDoneWhenBody(markdown: string): string {
  return doneWhenSectionBody(parseH2Bodies(markdown)).trim()
}

function doneWhenSectionBody(bodies: Map<string, string>): string {
  for (const key of DONE_WHEN_KEYS) {
    const body = bodies.get(key)
    if (body && planDraftBodyLines(body).length > 0) return body
  }
  return ''
}

/** Backticked symbols, file paths, or camel/PascalCase identifiers. */
const CONCRETE_ANCHOR_RE =
  /`[^`]+`|[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|yml|yaml|html)\b|(?:src|tests?|docs?|resources|scripts|landing)[/\\][\w./\\-]+|\b[A-Z][a-z]+\w*[A-Z]\w*\b|\b[a-z]+[A-Z]\w*\b/

/** Words that signal a verification story (tests, checks, commands). */
const VERIFICATION_RE =
  /\b(?:tests?|checked|checks?|vitest|typecheck|lint|verify|verified|verification|e2e|diagnostics|run_tests|screenshot|command output|build)\b/i

const CHECKLIST_RE = /^[-*+]\s*\[[ xX]\]/m

export type PlanQualityReport = {
  /** Heuristic 0–100 structure/quality score (higher is better). */
  score: number
  /** Actionable, advisory issues — empty for a complete, well-structured plan. */
  issues: string[]
}

/**
 * Heuristic structure check for a drafted plan — advisory only, never a
 * publish gate. Looks for a Goal body, an ordered Steps body anchored to real
 * paths/symbols with a verification story, and concrete Done-when criteria.
 * Pure function so the create_plan tool and the loop nudge share one report.
 */
export function scorePlanQuality(markdown: string): PlanQualityReport {
  const issues: string[] = []
  let score = 100
  const deduct = (points: number, issue: string): void => {
    issues.push(issue)
    score -= points
  }

  const bodies = parseH2Bodies(markdown)

  const goalBody = bodies.get('goal')
  if (!goalBody || planDraftBodyLines(goalBody).length === 0) {
    deduct(25, 'Missing ## Goal body — state the outcome in one or two sentences.')
  }

  const stepsBody = bodies.get('steps')
  const stepLines = stepsBody ? planDraftBodyLines(stepsBody) : []
  if (stepLines.length === 0) {
    deduct(25, 'Missing ## Steps body — list ordered, actionable steps under ## Steps.')
  } else if (stepLines.length < 2) {
    deduct(15, 'Only one step under ## Steps — decompose into two or more small, ordered steps.')
  }
  const stepsText = stepLines.join('\n')
  if (stepLines.length > 0 && !CONCRETE_ANCHOR_RE.test(stepsText)) {
    deduct(
      10,
      'Steps name no affected files or symbols — anchor each step with paths verified in this run.'
    )
  }

  const doneBody = doneWhenSectionBody(bodies)
  const doneLines = doneBody ? planDraftBodyLines(doneBody) : []
  if (doneLines.length === 0) {
    deduct(25, 'Missing ## Done when body — add concrete completion criteria.')
  } else if (!CHECKLIST_RE.test(doneBody) && !VERIFICATION_RE.test(doneBody)) {
    deduct(
      10,
      '## Done when is vague — use a `- [ ]` checklist or concrete criteria (tests, commands, outputs).'
    )
  }

  if (stepLines.length > 0 && !VERIFICATION_RE.test(`${stepsText}\n${doneLines.join('\n')}`)) {
    deduct(
      10,
      'No verification mentioned — say how the work is checked (tests, typecheck, lint, command output).'
    )
  }

  return { score: Math.max(0, Math.min(100, score)), issues }
}

const LEGACY_PLAN_STUB = [
  '# Plan',
  '',
  '_Draft the plan here. Update as you learn. Do not edit product source in Plan mode._',
  ''
].join('\n')

/**
 * Ready for Continue-in-Agent: real drafted body, not the empty stub.
 */
export function isPlanDraftReady(content: string | null | undefined): boolean {
  if (!content) return false
  const trimmed = content.trim()
  if (!trimmed) return false
  if (trimmed === LEGACY_PLAN_STUB.trim()) return false
  if (trimmed === DEFAULT_PLAN_STUB.trim()) return false
  return planDraftBodyLines(trimmed).length > 0
}

/** Minimal `plan.md` that satisfies Continue-in-Agent readiness. */
export function minimalReadyPlanMarkdown(): string {
  return [
    '# Ship the planner',
    '',
    '## Goal',
    '',
    'Publish a clear run plan through create_plan.',
    '',
    '## Steps',
    '',
    '1. Explore the workspace, then write plan.md.',
    '',
    '## Done when',
    '',
    'plan.md has a goal, steps, and a check for finished work.'
  ].join('\n')
}
