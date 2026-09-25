import { z } from 'zod'

/**
 * Done-when checks: the conditions a task is judged against, each marked by
 * the agent as met or not met with the evidence it saw. They come from the
 * New task form (`brief`) and from the Done when section of the agent's plan
 * (`plan`), and live in the run's `checks.json`.
 */
export const DoneWhenCheckSchema = z.object({
  /** `c1`, `c2`… — stable for the life of the check. */
  id: z.string().min(1),
  text: z.string().min(1),
  source: z.enum(['brief', 'plan']),
  /** Null until the agent marks it. */
  verdict: z.enum(['met', 'not_met']).nullable(),
  /** What the agent points at as proof: a command and its result, a file, a test. */
  evidence: z.string().optional(),
  createdAt: z.string(),
  markedAt: z.string().optional()
})
export type DoneWhenCheck = z.infer<typeof DoneWhenCheckSchema>

export const DoneWhenChecksFileSchema = z.object({
  checks: z.array(DoneWhenCheckSchema),
  /** The highest `cN` ever given out on this run, so a dropped check's id is never reused. */
  lastId: z.number().int().min(0).optional()
})

export const DONE_WHEN_CHECKS_FILE = 'checks.json'

/** Longest evidence kept per check — enough for a command and its verdict line. */
export const CHECK_EVIDENCE_MAX = 600

/** The checks in a `checks.json` body; empty for a missing or unreadable file. */
export function parseDoneWhenChecks(raw: string | null | undefined): DoneWhenCheck[] {
  if (!raw?.trim()) return []
  try {
    const parsed = DoneWhenChecksFileSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.checks : []
  } catch {
    return []
  }
}

/**
 * The list items of a Done when section: `- x`, `* x`, `1. x`, `- [ ] x`.
 * Prose around the list is not a check. Nested items fold into their parent.
 */
export function doneWhenBullets(body: string): string[] {
  const items: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const top = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line)
    if (top) {
      items.push(top[1]!.trim())
      continue
    }
    const nested = /^\s+(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line)
    if (nested && items.length > 0) items[items.length - 1] += ` — ${nested[1]!.trim()}`
  }
  return items.filter((t) => t.length > 0)
}

/** Case, spacing and trailing punctuation do not make a different check. */
export function normalizeCheckText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[.;:,\s]+$/, '').trim()
}

/** The N of the highest `cN` among these checks (0 when none). */
export function maxCheckNumber(checks: readonly DoneWhenCheck[]): number {
  let max = 0
  for (const c of checks) {
    const m = /^c(\d+)$/.exec(c.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

/** The next id after these checks and after `floor` — the highest id the run ever gave out. */
export function nextCheckId(checks: readonly DoneWhenCheck[], floor = 0): string {
  return `c${Math.max(maxCheckNumber(checks), floor) + 1}`
}

/**
 * The plan's Done when replaces the plan's checks. A bullet whose text is
 * unchanged keeps its id and verdict; a new bullet is a new, unmarked check;
 * a dropped bullet is no longer a check. Checks from the brief are untouched.
 */
export function mergePlanChecks(
  existing: readonly DoneWhenCheck[],
  bullets: readonly string[],
  now: string,
  /** The highest id the run ever gave out: checks dropped since still hold theirs. */
  floor = 0
): DoneWhenCheck[] {
  const brief = existing.filter((c) => c.source === 'brief')
  const prior = new Map(
    existing.filter((c) => c.source === 'plan').map((c) => [normalizeCheckText(c.text), c] as const)
  )
  const briefTexts = new Set(brief.map((c) => normalizeCheckText(c.text)))
  const out: DoneWhenCheck[] = [...brief]
  const seen = new Set<string>()
  for (const text of bullets) {
    const key = normalizeCheckText(text)
    // A plan restating a brief check is the same check, not a second one.
    if (!key || seen.has(key) || briefTexts.has(key)) continue
    seen.add(key)
    const kept = prior.get(key)
    // Ids are never reused: a dropped check's id must not come to mean another.
    out.push(kept ? { ...kept, text } : { id: nextCheckId([...existing, ...out], floor), text, source: 'plan', verdict: null, createdAt: now })
  }
  return out
}

export type CheckVerdictUpdate = { id: string; verdict: 'met' | 'not_met'; evidence: string }

/** Marks checks by id; ids that name no check are reported, not invented. */
export function applyCheckVerdicts(
  existing: readonly DoneWhenCheck[],
  updates: readonly CheckVerdictUpdate[],
  now: string
): { checks: DoneWhenCheck[]; applied: string[]; unknown: string[] } {
  const byId = new Map(updates.map((u) => [u.id.trim().toLowerCase(), u] as const))
  const applied: string[] = []
  const checks = existing.map((c) => {
    const u = byId.get(c.id.toLowerCase())
    if (!u) return c
    applied.push(c.id)
    return {
      ...c,
      verdict: u.verdict,
      evidence: u.evidence.trim().slice(0, CHECK_EVIDENCE_MAX),
      markedAt: now
    }
  })
  const known = new Set(existing.map((c) => c.id.toLowerCase()))
  const unknown = updates.map((u) => u.id.trim()).filter((id) => !known.has(id.toLowerCase()))
  return { checks, applied, unknown }
}

export function checksTally(checks: readonly DoneWhenCheck[]): { met: number; notMet: number; open: number; total: number } {
  let met = 0
  let notMet = 0
  for (const c of checks) {
    if (c.verdict === 'met') met += 1
    else if (c.verdict === 'not_met') notMet += 1
  }
  return { met, notMet, open: checks.length - met - notMet, total: checks.length }
}

/** The Done when block of contract.md, the checks listed by id. */
/** The contract's Done when when a task has no checks of its own. */
export function defaultDoneWhenBlock(): string {
  return [
    '## Done when',
    '',
    '- The goal above is satisfied (check outcomes: read results, command output, or user-visible success).',
    '- Or blockers are explained clearly and no further narrow retry will help.',
    '- Update this file if scope or done-when changes.'
  ].join('\n')
}

/** Replace the contract's `## Done when` section with `block`, or add it at the end. */
export function upsertDoneWhenSection(contract: string, block: string): string {
  const lines = contract.split(/\r?\n/)
  const start = lines.findIndex((line) => /^## Done when\b/i.test(line))
  if (start < 0) return `${contract.trimEnd()}\n\n${block}\n`
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) {
      end = i
      break
    }
  }
  return [...lines.slice(0, start), block, ...lines.slice(end)].join('\n').trimEnd() + '\n'
}

export function contractDoneWhenBlock(checks: readonly DoneWhenCheck[]): string {
  return [
    '## Done when',
    '',
    ...checks.map((c) => `- (${c.id}) ${c.text}`),
    '',
    'Before you finish, mark each check with `check_done_when`: met or not met, with the evidence you saw.'
  ].join('\n')
}
