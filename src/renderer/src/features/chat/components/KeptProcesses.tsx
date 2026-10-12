import { useEffect, useState } from 'react'
import type { KeptTerminalInfo } from '@shared/ipc'
import { Button } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { formatElapsed } from '@shared/utils/timeFormat'

/** How long it has been up, re-read each minute. */
function useUptime(startedAt: string): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const started = Date.parse(startedAt)
  return Number.isFinite(started) ? formatElapsed(Math.max(0, now - started)) : ''
}

function KeptRow({ item, onStop }: { item: KeptTerminalInfo; onStop: (id: string) => void }) {
  const uptime = useUptime(item.startedAt)
  return (
    <li className="flex h-8 items-center gap-2 text-xs" data-kept-process={item.id}>
      <Icon name="play" size={12} className="shrink-0 text-success" />
      <code className="min-w-0 flex-1 truncate font-mono text-fg" title={`${item.command}\n${item.cwd}`}>
        {item.command}
      </code>
      {uptime ? <span className="shrink-0 tabular-nums text-tertiary">{uptime}</span> : null}
      <Button size="xs" variant="ghost" icon="stop" onClick={() => onStop(item.id)}>
        Stop
      </Button>
    </li>
  )
}

/**
 * Processes the agent started and left running when its turn ended — a dev
 * server it said is up. They live until stopped here, stopped by the agent,
 * or the task is deleted.
 */
export function KeptProcesses({
  items,
  onStop,
  onShowTerminal,
  className
}: {
  items: readonly KeptTerminalInfo[]
  onStop: (id: string) => void
  /** Open the Terminal tab (from the record; the panel itself passes none). */
  onShowTerminal?: () => void
  className?: string
}) {
  if (items.length === 0) return null
  return (
    <section className={className} aria-label="Still running" data-kept-processes>
      <div className="flex h-6 items-center gap-2 text-caption text-muted">
        <span className="min-w-0 flex-1 truncate">
          Still running{items.length > 1 ? ` · ${items.length}` : ''}
        </span>
        {onShowTerminal ? (
          <Button size="xs" variant="ghost" icon="terminal" onClick={onShowTerminal}>
            Terminal
          </Button>
        ) : null}
      </div>
      <ul className="m-0 list-none p-0">
        {items.map((item) => (
          <KeptRow key={item.id} item={item} onStop={onStop} />
        ))}
      </ul>
    </section>
  )
}
