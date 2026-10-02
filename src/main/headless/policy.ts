import type { AgentQuestionAnswer, AgentQuestionRequest, ToolApprovalRequest } from '../../shared/ipc'
import { isAutonomousHighRiskTool } from '../agent/toolApproval'
import type { HeadlessApprovalPolicy } from './args'

/**
 * Who answers when nobody is there to click.
 *
 * A headless run answers only the questions the run's real approval gate
 * (toolApproval.ts) puts to it — the gate has already applied permission-rule
 * denies, protected paths and the approval mode by then, so nothing here can
 * let through a call those refuse. A call the gate HELD whatever the settings
 * say (the dangerous-command guard, a permission rule that asks) carries
 * `danger`; only a person may OK those, so every policy refuses them.
 */

export type HeadlessApprovalVerdict = {
  decision: 'once' | 'deny'
  /** Why — shown in progress output and the result's denied list. */
  reason: string
}

/**
 * Edits `allow-safe` lets through although autonomy counts them high-risk:
 * file edits inside the workspace, which the run's write checkpoint can undo.
 * Shell, delete, git, MCP and anything this run wrote itself stay refused.
 */
const SAFE_EDIT_TOOLS: ReadonlySet<string> = new Set(['edit', 'str_replace', 'edit_notebook'])

/**
 * The request's argument preview is capped (4000 chars) and scrubbed. A
 * preview that no longer parses must not read as "no command" — for
 * `run_tests` that would look like the project's own test run.
 */
function previewParses(argsPreview: string | undefined): boolean {
  if (!argsPreview) return true
  try {
    const parsed: unknown = JSON.parse(argsPreview)
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

export function decideHeadlessApproval(
  policy: HeadlessApprovalPolicy,
  request: Pick<ToolApprovalRequest, 'name' | 'argsPreview' | 'danger'>
): HeadlessApprovalVerdict {
  if (request.danger) {
    return {
      decision: 'deny',
      reason: `needs a person's OK (${request.danger}); headless runs refuse it`
    }
  }
  switch (policy) {
    case 'deny':
      return { decision: 'deny', reason: '--approval deny' }
    case 'allow-all':
      return { decision: 'once', reason: '--approval allow-all' }
    case 'allow-safe': {
      if (SAFE_EDIT_TOOLS.has(request.name)) return { decision: 'once', reason: '--approval allow-safe (file edit)' }
      const highRisk =
        !previewParses(request.argsPreview) || isAutonomousHighRiskTool(request.name, request.argsPreview)
      return highRisk
        ? { decision: 'deny', reason: `--approval allow-safe refuses ${request.name}` }
        : { decision: 'once', reason: '--approval allow-safe' }
    }
    default: {
      const exhaustive: never = policy
      return exhaustive
    }
  }
}

/** Text a headless run gives a model's free-text question. */
export const HEADLESS_QUESTION_ANSWER =
  'No human is available (headless run). Proceed with your best judgment and state the assumption you made.'

/**
 * What kind of question this is. The loop asks two of its own through the
 * same channel as `ask_question` — whether to run a workspace's hooks, and
 * whether to spend past the limit — and those are a person's call: a
 * headless run declines them (the loop then skips the hooks this once, or
 * stops at the limit) instead of answering on the person's behalf.
 */
export type HeadlessQuestionKind = 'model' | 'workspace-hooks' | 'spend-limit'

export function classifyHeadlessQuestion(request: Pick<AgentQuestionRequest, 'toolCallId'>): HeadlessQuestionKind {
  if (request.toolCallId.startsWith('workspace-hooks-')) return 'workspace-hooks'
  if (request.toolCallId.startsWith('spend-limit-')) return 'spend-limit'
  return 'model'
}

/**
 * Answers for a model's `ask_question` form: free-text items get
 * {@link HEADLESS_QUESTION_ANSWER}; choice items are left unanswered (picking
 * an option would be inventing the user's preference). All-unanswered reads
 * to the model as "skipped, continue with a reasonable default".
 */
export function headlessQuestionAnswers(request: Pick<AgentQuestionRequest, 'questions'>): AgentQuestionAnswer[] {
  return request.questions
    .filter((q) => q.type === 'text')
    .map((q) => ({ questionId: q.id, values: [HEADLESS_QUESTION_ANSWER] }))
}
