import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFile } from '../../storage/atomicWrite'
import { extractDoneWhenBody, isPlanDraftReady, scorePlanQuality } from '../../../shared/planQuality'
import { toolTodoWrite, type TodoItem } from './todo'

export type CreatePlanContext = {
  runDir?: string
}

export type CreatePlanResult = { ok: boolean; summary: string; content: string }

function upsertDoneWhen(contract: string, doneWhenBody: string): string {
  const block = `## Done when\n\n${doneWhenBody.trim()}`
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

function stripLeadingH1(markdown: string): string {
  return markdown.replace(/^\s*#\s+[^\n]+\n*/, '').trim()
}

/** Extract the first-line `# H1` title from plan markdown, if present. */
function deriveTitleFromPlan(plan: string): string {
  const match = plan.match(/^\s*#\s+(.+?)[ \t]*\r?\n/)
  return match ? match[1]!.trim() : ''
}

export function executeCreatePlan(
  _workspace: string,
  args: Record<string, unknown>,
  context: CreatePlanContext
): CreatePlanResult {
  const plan = typeof args.plan === 'string' ? args.plan.trim() : ''
  const argTitle = typeof args.title === 'string' ? args.title.trim() : ''
  const title = argTitle || deriveTitleFromPlan(plan)
  if (!title || !plan) {
    return {
      ok: false,
      summary: 'title',
      content:
        'create_plan requires title, or a plan whose first line is `# Title`. Resend with title, Goal, Scope, Steps, and Done when.'
    }
  }

  const markdown = `# ${title}\n\n${stripLeadingH1(plan)}\n`
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

  const doneWhen = extractDoneWhenBody(markdown)
  if (doneWhen) {
    const contractPath = join(runDir, 'contract.md')
    const prior = existsSync(contractPath) ? readFileSync(contractPath, 'utf8') : '## Goal\n\n'
    atomicWriteFile(contractPath, upsertDoneWhen(prior, doneWhen))
  }

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
      ? `Wrote plan.md. Copied Done when into contract.md ## Done when.${feedback}`
      : `Wrote plan.md.${feedback}`
  }
}
