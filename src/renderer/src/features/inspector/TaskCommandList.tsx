import { cn } from '@renderer/lib/ui'
import { formatElapsed } from '@shared/utils/timeFormat'
import { EmptyPanel } from '@renderer/features/chat/components/PanelChrome'
import type { TaskCommand } from './taskCommands'

/** What a command's line ends with: where it stands, then its exit code and time once it has one. */
function CommandOutcome({ command }: { command: TaskCommand }) {
  switch (command.state) {
    case 'waiting':
      return <span className="shrink-0 rounded-sm bg-accent-soft px-1 font-sans text-accent">waiting for you</span>
    case 'running':
      return <span className="shrink-0 font-sans vy-text-live">running</span>
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
 * What this task ran, oldest first: each command, where it stands, and the
 * last lines it printed. Read from the task's own record, so it is there for
 * a finished task as much as a running one.
 */
export function TaskCommandList({ commands }: { commands: readonly TaskCommand[] }) {
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
  return (
    <ol
      className="scroll-thin m-0 min-h-0 flex-1 list-none overflow-y-auto bg-sunken px-4 py-3 font-mono text-caption leading-mono"
      aria-label="What this task ran"
      data-task-commands
    >
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
          {command.tail.map((line, index) => (
            <div key={index} className="min-h-[1lh] whitespace-pre-wrap text-secondary [overflow-wrap:anywhere]">
              {line}
            </div>
          ))}
        </li>
      ))}
    </ol>
  )
}
