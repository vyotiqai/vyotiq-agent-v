import { IconButton, cn, Tooltip } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import type { PtySessionInfo } from '@shared/ipc'
import { tabMiddleClickHandlers } from './PanelChrome'

/** Package runners and their verbs name the tool, not the work. */
const RUNNERS = new Set(['pnpm', 'pnpx', 'npm', 'npx', 'yarn', 'bun', 'bunx'])
const RUNNER_VERBS = new Set(['run', 'exec', 'dlx', 'x'])

/**
 * The program a command line runs: `pnpm vitest run x` → `vitest`,
 * `git status` → `git`, `FOO=1 node a.js` → `node`.
 */
export function commandProgram(command: string): string {
  const words = command.trim().split(/\s+/).filter(Boolean)
  const base = (word: string): string => word.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '')
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i += 1
  const first = words[i]
  if (!first) return command.trim()
  if (RUNNERS.has(base(first).toLowerCase())) {
    let j = i + 1
    while (j < words.length && (words[j]!.startsWith('-') || RUNNER_VERBS.has(words[j]!.toLowerCase()))) j += 1
    if (j < words.length) return base(words[j]!)
  }
  return base(first)
}

/**
 * The terminal's session row: the agent's read-only session first when there
 * is one, then your shells, New and Split. One 40px row, like every pane.
 */
export function TerminalSessionBar({
  sessions,
  activeId,
  splitId,
  agentCommand = null,
  onSelect,
  onKill,
  onCreate,
  onToggleSplit
}: {
  sessions: PtySessionInfo[]
  activeId: string | null
  splitId: string | null
  /** The command the run is executing right now, if any. */
  agentCommand?: string | null
  onSelect: (id: string) => void
  onKill: (id: string) => void
  onCreate: () => void
  onToggleSplit: () => void
}) {
  const activeSession = sessions.find((s) => s.id === activeId) ?? null
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2"
      data-terminal-session-bar
      role="tablist"
      aria-label="Terminal sessions"
    >
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {sessions.map((s) => {
          const selected = s.id === activeId
          const emphasized = selected || Boolean(splitId && s.id === splitId)
          const agent = s.backend === 'agent'
          const live = agent && agentCommand !== null
          const name = agent ? 'Agent' : s.title
          const label = agent
            ? agentCommand
              ? `Agent · ${commandProgram(agentCommand)}`
              : 'Agent'
            : s.running
              ? s.title
              : `${s.title} (exited)`
          const tip = agent
            ? agentCommand
              ? `Running ${agentCommand}`
              : 'The run’s commands, read-only'
            : label
          return (
            <div
              key={s.id}
              className={cn(
                'group inline-flex h-7 shrink-0 items-center rounded-md vy-transition',
                emphasized ? 'bg-surface-2 text-fg-strong' : 'text-muted hover:bg-surface hover:text-fg'
              )}
              {...tabMiddleClickHandlers(() => onKill(s.id))}
            >
              <Tooltip content={tip}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={emphasized ? 0 : -1}
                  className="inline-flex h-full max-w-[12rem] items-center gap-1.5 rounded-md pl-2 pr-2 text-xs focus-visible:vy-focus-ring"
                  onKeyDown={(e) => {
                    if (e.key === 'Delete') {
                      e.preventDefault()
                      onKill(s.id)
                    }
                  }}
                  onClick={() => onSelect(s.id)}
                >
                  <Icon name={agent ? 'robot' : 'terminal'} size={13} className="shrink-0" />
                  <span className="min-w-0 truncate">{label}</span>
                  {live ? (
                    <>
                      <span aria-hidden="true" className="size-1.5 shrink-0 animate-live rounded-full bg-accent" />
                      <span className="sr-only">, working now</span>
                    </>
                  ) : null}
                </button>
              </Tooltip>
              <button
                type="button"
                className="-ml-1 mr-1 hidden size-4 shrink-0 place-items-center rounded-sm text-tertiary hover:bg-surface-2 hover:text-fg focus-visible:inline-grid focus-visible:vy-focus-ring group-focus-within:inline-grid group-hover:inline-grid"
                aria-label={`Close ${name}`}
                aria-keyshortcuts="Delete"
                tabIndex={emphasized ? 0 : -1}
                onClick={(e) => {
                  e.stopPropagation()
                  onKill(s.id)
                }}
              >
                <Icon name="close" size={10} />
              </button>
            </div>
          )
        })}
      </div>
      <IconButton icon="plus" label="New terminal" size="sm" tone="muted" onClick={onCreate} />
      <span className="flex-1" />
      {activeSession ? (
        <IconButton
          icon="columns"
          label={splitId ? 'Unsplit terminals' : 'Split terminal'}
          size="sm"
          tone="muted"
          aria-pressed={splitId != null}
          onClick={onToggleSplit}
        />
      ) : null}
    </div>
  )
}
