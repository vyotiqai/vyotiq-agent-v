import { useEffect, useMemo, useRef, type ReactElement, type UIEvent } from 'react'
import { cn } from '@renderer/lib/ui'
import { TOOL_TERMINAL_VIEWPORT } from '@renderer/lib/utils/layout'
import { useSharedNow } from '@renderer/lib/hooks/useSharedNow'
import { sanitizeTerminalDisplayText } from '@shared/utils/terminalFormat'
import type { ToolBodyProps } from '../types'
import { parseTerminalCardData } from '../parsers/terminal'
import { TruncatedBanner } from '../primitives'

const VIEWPORT_PIN_PX = 24

function TerminalDivider(): ReactElement {
  return <span className="block text-tertiary/70" aria-hidden>
    ---
  </span>
}

function resolveStartedAt(timing: ToolBodyProps['timing']): number | undefined {
  const started = timing?.startedAt
  return started != null && Number.isFinite(started) ? started : undefined
}

function resolveEndedAt(timing: ToolBodyProps['timing']): number | undefined {
  const ended = timing?.endedAt
  return ended != null && Number.isFinite(ended) ? ended : undefined
}

export function TerminalBody({ tool, loading, loadFailed, timing }: ToolBodyProps) {
  const data = useMemo(() => {
    const parsed = parseTerminalCardData(tool)
    return {
      ...parsed,
      command: sanitizeTerminalDisplayText(parsed.command),
      output: sanitizeTerminalDisplayText(parsed.output),
      stderr: sanitizeTerminalDisplayText(parsed.stderr)
    }
  }, [tool])
  const running = tool.status === 'running'
  const viewportRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const streamKey = `${data.output.length}:${data.stderr.length}:${data.cwd}:${data.shell}`
  const startedAt = resolveStartedAt(timing)
  const endedAt = resolveEndedAt(timing)

  // Reuse the single shared 1 Hz clock instead of a per-card setInterval — many
  // mounted terminal cards previously each fired their own timer + re-render/sec.
  const nowMs = useSharedNow(running && startedAt != null)

  useEffect(() => {
    if (running) pinnedRef.current = true
  }, [running])

  useEffect(() => {
    if (!running) return
    const el = viewportRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [running, streamKey])

  const onViewportScroll = (event: UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= VIEWPORT_PIN_PX
  }

  const metaLines: string[] = []
  if (startedAt != null) {
    // Prefer real wall-clock meta when present (matches reference keys).
    metaLines.push(`started_at: ${new Date(startedAt).toISOString()}`)
    const endMs = running ? nowMs : (endedAt ?? undefined)
    if (endMs != null && endMs >= startedAt) {
      // Live clock while the command runs; fixed duration once it settles.
      metaLines.push(`${running ? 'running' : 'ran'}_for_ms: ${Math.max(0, endMs - startedAt)}`)
    }
  }
  // Always surface cwd/shell when known — timing must not hide workspace context.
  if (data.cwd) metaLines.push(`cwd: ${data.cwd}`)
  if (data.shell) metaLines.push(`shell: ${data.shell}`)
  if (data.sessionStatus) metaLines.push(`status: ${data.sessionStatus}`)

  const hasMeta = metaLines.length > 0
  const hasCommand = Boolean(data.command)
  const hasStream = Boolean(data.output || data.stderr)

  return (
    <div
      ref={viewportRef}
      data-testid="terminal-viewport"
      role="region"
      aria-label="Terminal output"
      tabIndex={0}
      aria-busy={loading || running || undefined}
      className={cn(TOOL_TERMINAL_VIEWPORT)}
      onScroll={onViewportScroll}
    >
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      <pre
        className={cn(
          'm-0 px-3 py-2 font-mono text-caption leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]'
        )}
      >
        {hasMeta
          ? metaLines.map((line) => (
              <span key={line} className="block text-tertiary">
                {line}
              </span>
            ))
          : null}
        {hasMeta && (hasCommand || hasStream) ? <TerminalDivider /> : null}
        {hasCommand ? (
          <span className="block text-fg/90">{`$ ${data.command}`}</span>
        ) : null}
        {hasCommand && hasStream ? <TerminalDivider /> : null}
        {data.output ? <span className="text-fg/75">{data.output}</span> : null}
        {data.stderr ? (
          <span className="text-danger">
            {data.output ? '\n' : ''}
            {data.stderr}
          </span>
        ) : null}
      </pre>
    </div>
  )
}
