import { cn } from '@renderer/lib/ui'
import { useSharedNow } from '@renderer/lib/hooks/useSharedNow'
import { formatElapsed } from '@shared/utils/timeFormat'
import { EmptyPanel } from '@renderer/features/chat/components/PanelChrome'
import { linesLeftOut } from '@renderer/features/chat/components/linesLeftOut'
import { commandsRanIn, type TaskCommand } from './taskCommands'

/**
 * Still going, as the record's command card says it: the word carries the
 * motion, and the time counts up where the final one lands.
 */
function RunningOutcome({ startedAt }: { startedAt: string | null }) {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN
  const now = useSharedNow(Number.isFinite(start))
  return (
    <>
      <span className="shrink-0 font-sans vy-text-live">running</span>
      {Number.isFinite(start) ? (
        <span className="shrink-0 text-tertiary tnum" data-task-command-elapsed>
          {formatElapsed(Math.max(0, now - start))}
        </span>
      ) : null}
    </>
  )
}

/** What a command's line ends with: where it stands, then its exit code and time once it has one. */
function CommandOutcome({ command }: { command: TaskCommand }) {
  switch (command.state) {
    case 'waiting':
      return <span className="shrink-0 rounded-sm bg-accent-soft px-1 font-sans text-accent">waiting for you</span>
    case 'running':
      return <RunningOutcome startedAt={command.startedAt} />
    case 'refused':
      // It never ran: there is no exit code to report.
      return <span className="shrink-0 font-sans text-muted">{command.refusal?.toLowerCase() ?? 'denied'}</span>
    case 'stopped':
      return <span className="shrink-0 font-sans text-tertiary">stopped</span>
    default: {
      const time = command.durationMs != null ? formatElapsed(command.durationMs) : null
      const parts = [command.exitCode != null ? `exit ${command.exitCode}` : command.state === 'failed' ? 'failed' : null, time]
        .filter(Boolean)
        .join(' · ')
      if (!parts) return null
      // Word and colour: "exit 1" says it failed without the red.
      return (
        <span className={cn('shrink-0 tnum', command.state === 'failed' ? 'text-danger' : 'text-tertiary')}>{parts}</span>
      )
    }
  }
}

/**
 * What this task ran, oldest first, under where it ran: each command, where
 * it stands, and the last lines it printed, saying how many came before them.
 * Read from the task's own record, so it is there for a finished task as much
 * as a running one.
 */
export function TaskCommandList({
  commands,
  workspacePath = null
}: {
  commands: readonly TaskCommand[]
  /** The task's workspace; a command that reports a directory outside it (a worktree) names that instead. */
  workspacePath?: string | null
}) {
  if (commands.length === 0) {
    return (
      <EmptyPanel
        icon="terminal"
        title="Nothing run yet"
        body="Every command this task runs lands here, with its output and exit code."
        centered
      />
    )
  }
  const where = commandsRanIn(commands, workspacePath)
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-sunken px-4 py-3 font-mono text-caption leading-mono">
      <p className="m-0 mb-3 truncate text-tertiary" title={where?.path || undefined} data-task-commands-where>
        {where ? `${where.name} · what this task ran` : 'What this task ran'}
      </p>
      <ol className="m-0 list-none p-0" aria-label="What this task ran" data-task-commands>
        {commands.map((command) => (
          <li key={command.id} className="mb-3 last:mb-0" data-task-command={command.state}>
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 text-tertiary" aria-hidden>
                $
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]',
                  command.state === 'waiting' ? 'text-tertiary' : 'text-fg-strong'
                )}
              >
                {command.command}
              </span>
              <CommandOutcome command={command} />
            </div>
            {/* The output is cut to its last lines: say so, rather than pass a tail off as the whole. */}
            {command.earlier > 0 ? (
              <div className="font-sans text-tertiary" data-task-command-earlier>
                {linesLeftOut(command.earlier, 'earlier')}
              </div>
            ) : null}
            {command.tail.map((line, index) => (
              <div key={index} className="min-h-[1lh] whitespace-pre-wrap text-secondary [overflow-wrap:anywhere]">
                {line}
              </div>
            ))}
          </li>
        ))}
      </ol>
    </div>
  )
}
