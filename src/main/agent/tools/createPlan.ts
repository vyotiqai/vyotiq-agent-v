import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFile } from '../../storage/atomicWrite'
import { extractDoneWhenBody, isPlanDraftReady, scorePlanQuality } from '../../../shared/planQuality'
import { contractDoneWhenBlock, mergePlanChecks, upsertDoneWhenSection } from '../../../shared/doneWhenChecks'
import { planCheckBullets, readChecks, readChecksLastId, writeChecks } from '../doneWhenChecks'
import { planMarkdownFromArgs } from './planMarkdown'
import { toolTodoWrite, type TodoItem } from './todo'

export type CreatePlanContext = {
  runDir?: string
}

export type CreatePlanResult = { ok: boolean; summary: string; content: string }

export function executeCreatePlan(
  _workspace: string,
  args: Record<string, unknown>,
  context: CreatePlanContext
): CreatePlanResult {
  const built = planMarkdownFromArgs(args)
  if (!built) {
    return {
      ok: false,
      summary: 'title',
      content:
        'create_plan requires title, or a plan whose first line is `# Title`. Resend with title, Goal, Scope, Steps, and Done when.'
    }
  }
  const { title, markdown } = built
  if (!isPlanDraftReady(markdown)) {
    return {
      ok: false,
      summary: title,
      content: 'create_plan needs a real plan (Goal, Steps, and Done when) — not the empty stub.'
    }
  }

  const runDir = context.runDir
  if (!runDir) {
    return {
      ok: false,
      summary: title,
      content: 'create_plan requires an active run directory.'
    }
  }

  atomicWriteFile(join(runDir, 'plan.md'), markdown)

  // The plan's Done when list becomes its checks (the brief's stay), and the
  // contract lists every check by id so the agent can mark them.
  const checks = mergePlanChecks(readChecks(runDir), planCheckBullets(markdown), new Date().toISOString(), readChecksLastId(runDir))
  writeChecks(runDir, checks)
  const doneWhen = extractDoneWhenBody(markdown)
  if (checks.length > 0 || doneWhen) {
    const contractPath = join(runDir, 'contract.md')
    const prior = existsSync(contractPath) ? readFileSync(contractPath, 'utf8') : '## Goal\n\n'
    const block = checks.length > 0 ? contractDoneWhenBlock(checks) : `## Done when\n\n${doneWhen.trim()}`
    atomicWriteFile(contractPath, upsertDoneWhenSection(prior, block))
  }
  const checksNote =
    checks.length > 0
      ? ` Done-when checks: ${checks.map((c) => `${c.id} ${c.text}`).join('; ')}. Mark each with check_done_when before you finish.`
      : ''

  const todos = Array.isArray(args.todos) ? (args.todos as TodoItem[]) : []
  if (todos.length > 0) {
    toolTodoWrite(runDir, todos, true)
  }

  const quality = scorePlanQuality(markdown)
  const feedback =
    quality.issues.length > 0
      ? ` Quality feedback (advisory, score ${quality.score}/100): ${quality.issues.slice(0, 3).join(' ')}`
      : ''

  return {
    ok: true,
    summary: title,
    content: doneWhen
      ? `Wrote plan.md. Copied Done when into contract.md ## Done when.${checksNote}${feedback}`
      : `Wrote plan.md.${checksNote}${feedback}`
  }
}
