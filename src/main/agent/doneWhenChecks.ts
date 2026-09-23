import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { atomicWriteJson } from '@main/storage/atomicWrite'
import type { ChatMessage } from '../../shared/ipc'
import {
  DONE_WHEN_CHECKS_FILE,
  applyCheckVerdicts,
  checksTally,
  doneWhenBullets,
  mergePlanChecks,
  parseDoneWhenChecks,
  type CheckVerdictUpdate,
  type DoneWhenCheck
} from '../../shared/doneWhenChecks'
import { extractDoneWhenBody, isPlanDraftReady } from '../../shared/planQuality'
import { planMarkdownFromArgs } from './tools/planMarkdown'

/**
 * The run's done-when checks on disk (`checks.json`). The loop reads them only
 * at turn end — never into the prompt per step — so marking a check cannot
 * disturb the cached prompt prefix.
 */
export function checksPath(runDir: string): string {
  return join(runDir, DONE_WHEN_CHECKS_FILE)
}

export function readChecks(runDir: string | undefined): DoneWhenCheck[] {
  if (!runDir) return []
  const p = checksPath(runDir)
  if (!existsSync(p)) return []
  try {
    return parseDoneWhenChecks(readFileSync(p, 'utf8'))
  } catch {
    return []
  }
}

export function writeChecks(runDir: string, checks: readonly DoneWhenCheck[]): void {
  if (checks.length === 0) {
    rmSync(checksPath(runDir), { force: true })
    return
  }
  atomicWriteJson(checksPath(runDir), { checks })
}

/** The Done when bullets of a plan, when the plan is a real one. */
export function planCheckBullets(markdown: string): string[] {
  if (!isPlanDraftReady(markdown)) return []
  const body = extractDoneWhenBody(markdown)
  return body ? doneWhenBullets(body) : []
}

function parseUpdates(args: Record<string, unknown>): CheckVerdictUpdate[] | string {
  if (!Array.isArray(args.checks) || args.checks.length === 0) {
    return 'check_done_when needs checks: [{ id, verdict: "met" | "not_met", evidence }].'
  }
  const updates: CheckVerdictUpdate[] = []
  for (const raw of args.checks) {
    if (!raw || typeof raw !== 'object') return 'Each check needs id, verdict and evidence.'
    const row = raw as { id?: unknown; verdict?: unknown; evidence?: unknown }
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    const verdict = row.verdict === 'met' || row.verdict === 'not_met' ? row.verdict : null
    const evidence = typeof row.evidence === 'string' ? row.evidence.trim() : ''
    if (!id || !verdict) return `Check ${id || '(no id)'}: verdict must be "met" or "not_met".`
    if (!evidence) return `Check ${id}: evidence is required — the command and its result, the file, or why it is not met.`
    updates.push({ id, verdict, evidence })
  }
  return updates
}

function tallyLine(checks: readonly DoneWhenCheck[]): string {
  const t = checksTally(checks)
  const open = checks.filter((c) => c.verdict === null).map((c) => c.id)
  return `${t.met} of ${t.total} checks met${t.notMet ? `, ${t.notMet} not met` : ''}${open.length ? `; still unmarked: ${open.join(', ')}` : ''}.`
}

/** `check_done_when`: mark checks met or not met, each with its evidence. */
export function executeCheckDoneWhen(
  runDir: string | undefined,
  args: Record<string, unknown>
): { ok: boolean; summary: string; content: string } {
  if (!runDir) return { ok: false, summary: 'No run', content: 'check_done_when requires an active run directory.' }
  const existing = readChecks(runDir)
  if (existing.length === 0) {
    return {
      ok: false,
      summary: 'No checks',
      content:
        'This run has no done-when checks. They come from the task brief or from the Done when list of create_plan.'
    }
  }
  const updates = parseUpdates(args)
  if (typeof updates === 'string') return { ok: false, summary: 'Invalid', content: updates }
  const { checks, applied, unknown } = applyCheckVerdicts(existing, updates, new Date().toISOString())
  if (applied.length === 0) {
    return {
      ok: false,
      summary: 'Unknown ids',
      content: `No check has the id ${unknown.join(', ')}. The checks are: ${existing.map((c) => `${c.id} ${c.text}`).join('; ')}.`
    }
  }
  writeChecks(runDir, checks)
  const marked = applied
    .map((id) => {
      const c = checks.find((x) => x.id === id)!
      return `${id} ${c.verdict === 'met' ? 'met' : 'not met'}`
    })
    .join(', ')
  const t = checksTally(checks)
  return {
    ok: true,
    summary: `${t.met}/${t.total} met`,
    content: `${marked}. ${tallyLine(checks)}${unknown.length ? ` Unknown ids ignored: ${unknown.join(', ')}.` : ''}`
  }
}

/** The one turn-end reminder when the agent is about to finish with checks unmarked. */
export function doneWhenNudgeText(checks: readonly DoneWhenCheck[]): string | null {
  const open = checks.filter((c) => c.verdict === null)
  if (open.length === 0) return null
  // A turn also ends when the agent stops to ask the user something — it must
  // not be pushed into marking checks it has not finished.
  return [
    'If you are finishing, first mark each done-when check with `check_done_when` — met or not met, each with the evidence you saw (the command and its result, the file, or why it is not met):',
    ...open.map((c) => `- ${c.id}: ${c.text}`),
    'If you are only pausing to ask the user something, leave them open and say so.'
  ].join('\n')
}

/**
 * After a rewind the checks are whatever the kept history made them: the
 * brief's checks, unmarked, then every kept `create_plan` and `check_done_when`
 * replayed in order. A plan or a verdict the rewind removed is gone with it.
 */
export function syncChecksAfterRewind(runDir: string, messages: readonly ChatMessage[]): void {
  let checks: DoneWhenCheck[] = readChecks(runDir)
    .filter((c) => c.source === 'brief')
    .map((c) => ({ id: c.id, text: c.text, source: c.source, verdict: null, createdAt: c.createdAt }))
  const failed = new Set(
    messages.filter((m) => m.role === 'tool' && m.ok === false && m.toolCallId).map((m) => m.toolCallId!)
  )
  // A check is dated by the instruction whose run made it, so the record
  // still shows it under that run.
  let runAt: string | null = null
  for (const m of messages) {
    if (m.role === 'user' && !m.synthetic && m.at) runAt = m.at
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue
    for (const call of m.toolCalls) {
      if (failed.has(call.id)) continue
      if (call.name !== 'create_plan' && call.name !== 'check_done_when') continue
      let args: Record<string, unknown>
      try {
        args = JSON.parse(call.arguments) as Record<string, unknown>
      } catch {
        continue
      }
      const at = runAt ?? new Date().toISOString()
      if (call.name === 'create_plan') {
        const plan = planMarkdownFromArgs(args)
        if (plan) checks = mergePlanChecks(checks, planCheckBullets(plan.markdown), at)
      } else {
        const updates = parseUpdates(args)
        if (typeof updates !== 'string') checks = applyCheckVerdicts(checks, updates, at).checks
      }
    }
  }
  writeChecks(runDir, checks)
}
