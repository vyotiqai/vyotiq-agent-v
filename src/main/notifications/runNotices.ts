import type { AgentQuestionRequest, RunStatus, ToolApprovalRequest } from '../../shared/ipc'
import { checksTally } from '../../shared/doneWhenChecks'
import { approvalAsk, questionAsk } from '../../shared/needsYouText'
import { logger } from '../../shared/logger'
import { taskTitleFromGoal } from '../../shared/utils/taskTitle'
import { parseMcpToolDisplay } from '../../shared/utils/toolSummary'
import { readChecks } from '../agent/doneWhenChecks'
import { pendingReviewSummary } from '../agent/reviewSummary'
import { loadStatus } from '../agent/state'
import { resolveEffectiveMcpServers } from '../marketplace/resolve'
import { resolveRunDir } from '../storage/paths'
import { findWorkspaceSettingsOverride, getWorkspaces } from '../workspace/workspaces'

/**
 * What a notification says about a task. The title names the task the way the
 * navigator does; the body says what happened to it. The same two lines are
 * the inbox row and, when the window is away, the OS notification.
 */
export type RunNotice = { title: string; body: string; reviewFiles?: number }

/** The navigator's name for a task: its goal's first line, a teammate's name before it. */
export function noticeTaskTitle(
  status: Pick<RunStatus, 'goal' | 'agentProfileName'> | null | undefined,
  runId: string
): string {
  const goal = status?.goal?.trim()
  const title = goal ? taskTitleFromGoal(goal) : ''
  const teammate = status?.agentProfileName?.trim()
  if (teammate) return title ? `${teammate} · ${title}` : teammate
  return title || runId.slice(0, 8)
}

/** A tool call waiting on Allow — "Wants to run pnpm vitest run …". */
export function needsYouApprovalNotice(
  task: string,
  request: Pick<ToolApprovalRequest, 'name' | 'summary' | 'argsPreview'>,
  serverNames?: () => ReadonlyMap<string, string>
): RunNotice {
  const names = parseMcpToolDisplay(request.name) ? serverNames?.() : undefined
  return { title: task, body: approvalAsk(request, names) }
}

/** A question waiting on an answer — "Asks: Which branch?". */
export function needsYouQuestionNotice(
  task: string,
  request: Pick<AgentQuestionRequest, 'title' | 'questions'>
): RunNotice {
  return { title: task, body: questionAsk(request) }
}

function filesWord(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`
}

/**
 * A run that stopped: "Ready for review · 3 files · 2/2 checks met" while its
 * edits wait on Keep or Undo, "Finished" when nothing does, and "Failed:" with
 * the error the run stopped on — plus the edits it left, as the navigator
 * counts them.
 */
export function runFinishedNotice(input: {
  task: string
  failed: boolean
  /** The run's own error, as its status recorded it. */
  error?: string | undefined
  /** Files still waiting on Keep or Undo. */
  reviewFiles?: number | undefined
  checks?: { met: number; total: number } | undefined
}): RunNotice {
  const files = input.reviewFiles && input.reviewFiles > 0 ? input.reviewFiles : 0
  const review = files > 0 ? { reviewFiles: files } : {}
  if (input.failed) {
    const reason = input.error?.trim().split(/\r?\n/, 1)[0]?.trim()
    const parts = [reason ? `Failed: ${reason}` : 'Failed']
    if (files > 0) parts.push(`${filesWord(files)} to review`)
    return { title: input.task, body: parts.join(' · '), ...review }
  }
  const parts = files > 0 ? ['Ready for review', filesWord(files)] : ['Finished']
  if (input.checks && input.checks.total > 0) parts.push(`${input.checks.met}/${input.checks.total} checks met`)
  return { title: input.task, body: parts.join(' · '), ...review }
}

function readStatus(workspacePath: string, runId: string): RunStatus | null {
  try {
    return loadStatus(resolveRunDir(workspacePath, runId))
  } catch {
    return null
  }
}

/** Server names as Extensions shows them. Never throws: the approval is on its way either way. */
function mcpServerNames(workspacePath: string): ReadonlyMap<string, string> {
  try {
    const overrides = findWorkspaceSettingsOverride(getWorkspaces(), workspacePath)?.marketplaceOverrides ?? null
    return new Map(resolveEffectiveMcpServers(overrides).map((server) => [server.id, server.name]))
  } catch {
    return new Map()
  }
}

/** The notice for an approval a run is waiting on, read from the run as it is now. */
export function approvalNoticeFor(
  workspacePath: string,
  runId: string,
  request: Pick<ToolApprovalRequest, 'name' | 'summary' | 'argsPreview'>
): RunNotice {
  return needsYouApprovalNotice(noticeTaskTitle(readStatus(workspacePath, runId), runId), request, () =>
    mcpServerNames(workspacePath)
  )
}

/** The notice for a question a run is waiting on. */
export function questionNoticeFor(
  workspacePath: string,
  runId: string,
  request: Pick<AgentQuestionRequest, 'title' | 'questions'>
): RunNotice {
  return needsYouQuestionNotice(noticeTaskTitle(readStatus(workspacePath, runId), runId), request)
}

/**
 * The notice for a run that just stopped: its edits and checks as they are on
 * disk now — the loop wrote its last checkpoint before the run ended.
 */
export function finishedNoticeFor(input: {
  workspacePath: string
  runId: string
  runDir: string
  failed: boolean
  status: RunStatus | null | undefined
}): RunNotice {
  const { workspacePath, runId, runDir, failed, status } = input
  let reviewFiles: number | undefined
  try {
    reviewFiles = pendingReviewSummary(runDir, workspacePath)?.files
  } catch (err) {
    logger.warn('Could not count the edits a finished run left for review', {
      scope: 'notifications',
      correlationId: runId,
      err
    })
  }
  const checks = readChecks(runDir)
  return runFinishedNotice({
    task: noticeTaskTitle(status, runId),
    failed,
    error: status?.error,
    reviewFiles,
    checks: checks.length > 0 ? checksTally(checks) : undefined
  })
}
