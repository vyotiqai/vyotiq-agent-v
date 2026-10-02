import type { UiItem } from '@shared/transcript'
import { workspacePathIsInside } from '@shared/workspacePathMatch'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { approvalRefusalOf, isInterruptedToolContent } from '@renderer/features/chat/toolUi'
import { parseTerminalCardData } from '@renderer/features/chat/toolUi/parsers/terminal'
import { toolDurationMs } from '@renderer/features/task/record/WorkItems'

type ToolItem = Extract<UiItem, { kind: 'tool' }>

/**
 * Where one command stands, as the record's command card reads it: held for
 * your approval, still going, refused before it ran, stopped with the run,
 * failed, or done.
 */
export type TaskCommandState = 'waiting' | 'running' | 'refused' | 'stopped' | 'failed' | 'done'

export type TaskCommand = {
  id: string
  command: string
  state: TaskCommandState
  exitCode: number | null
  /** Settled calls only. */
  durationMs: number | null
  /** "Denied" / "Timed out" for a refused call. */
  refusal: string | null
  /** The last lines it printed, stdout then stderr. */
  tail: string[]
  /** Lines it printed before those, left out of `tail`. */
  earlier: number
  /** When the call started (ISO): a running command's time counts up from it. */
  startedAt: string | null
  /** The directory it ran in, as the call reported it; empty until it says. */
  cwd: string
}

/** How many of a command's last lines the list shows under it. */
export const COMMAND_TAIL_LINES = 6

function tailOf(text: string, max: number): { tail: string[]; earlier: number } {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/)
  if (lines.length === 1 && lines[0] === '') return { tail: [], earlier: 0 }
  return { tail: lines.slice(-max), earlier: Math.max(0, lines.length - max) }
}

/** One `terminal` call as the list shows it, classified exactly as its card in the record. */
export function taskCommandOf(item: ToolItem): TaskCommand {
  const { tool } = item
  const data = parseTerminalCardData(tool)
  const awaiting = Boolean(item.approval) && tool.status === 'running'
  const running = !awaiting && (tool.status === 'running' || data.sessionStatus === 'running')
  const refusal = tool.status === 'fail' ? approvalRefusalOf(tool.content) : null
  const stopped = !running && !awaiting && isInterruptedToolContent(tool.content)
  const exit = data.exitCode
  const failed = !refusal && !stopped && (tool.status === 'fail' || (exit != null && exit !== 0 && exit !== -1))
  const state: TaskCommandState = awaiting
    ? 'waiting'
    : running
      ? 'running'
      : refusal
        ? 'refused'
        : stopped
          ? 'stopped'
          : failed
            ? 'failed'
            : 'done'
  const printed = [data.output, data.stderr].filter((part) => part.trim()).join('\n')
  const { tail, earlier } = refusal || stopped ? { tail: [], earlier: 0 } : tailOf(printed, COMMAND_TAIL_LINES)
  return {
    id: item.id,
    command: data.command,
    state,
    exitCode: exit,
    durationMs: running || awaiting ? null : toolDurationMs(item),
    refusal,
    tail,
    earlier,
    startedAt: item.at ?? null,
    cwd: data.cwd
  }
}

/**
 * Where the task's commands ran, named by its folder: the workspace, unless
 * they ran outside it (a task worktree), and then the first directory they
 * reported. Null when neither is known.
 */
export function commandsRanIn(
  commands: readonly TaskCommand[],
  workspacePath: string | null | undefined
): { name: string; path: string } | null {
  const cwd = commands.find((command) => command.cwd)?.cwd ?? ''
  const elsewhere = Boolean(cwd) && (!workspacePath || !workspacePathIsInside(workspacePath, cwd))
  const path = elsewhere ? cwd : (workspacePath ?? '')
  const name = formatWorkspaceName(path, '')
  return name ? { name, path } : null
}

/** Every command this task ran, oldest first. */
export function collectTaskCommands(items: readonly UiItem[]): TaskCommand[] {
  const out: TaskCommand[] = []
  for (const item of items) {
    if (item.kind === 'tool' && item.tool.name === 'terminal') out.push(taskCommandOf(item))
  }
  return out
}
