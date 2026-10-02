import { useEffect, useMemo, useRef, type ReactElement, type ReactNode, type UIEvent } from 'react'
import { cn } from '@renderer/lib/ui'
import { TOOL_TERMINAL_VIEWPORT } from '@renderer/lib/utils/layout'
import { sanitizeTerminalDisplayText } from '@shared/utils/terminalFormat'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { useRunSession } from '../../RunSessionContext'
import type { ToolBodyProps } from '../types'
import { parseTerminalCardData } from '../parsers/terminal'
import { TruncatedBanner } from '../primitives'

const VIEWPORT_PIN_PX = 24

/** A test runner's pass and fail marks at the start of a line. */
const PASS_MARKS = '✓✔'
const MARK_LINE = /^(\s*)([✓✔✗✘✕×])(.*)$/
const ANY_MARK = /[✓✔✗✘✕×]/

/**
 * Test output reads at a glance: a line's pass mark in the success hue and a
 * failure mark in danger, each line lifted a step off the quiet rest. The
 * glyph itself stays, so the hue is never the only thing that says it.
 */
export function markedOutput(text: string): ReactNode {
  if (!ANY_MARK.test(text)) return text
  const out: ReactNode[] = []
  let plain = ''
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? '\n' : ''
    const m = MARK_LINE.exec(line)
    if (!m) {
      plain += line + nl
      return
    }
    if (plain) out.push(plain)
    plain = nl
    const pass = PASS_MARKS.includes(m[2]!)
    out.push(
      <span key={i} className={pass ? 'text-fg' : 'text-fg-strong'} data-output-mark={pass ? 'pass' : 'fail'}>
        {m[1]}
        <span className={pass ? 'text-success' : 'text-danger'}>{m[2]}</span>
        {m[3]}
      </span>
    )
  })
  if (plain) out.push(plain)
  return out
}

function TerminalDivider(): ReactElement {
  return <span className="block text-tertiary" aria-hidden>
    ---
  </span>
}

export function TerminalBody({ tool, loading, loadFailed, inGroup }: ToolBodyProps) {
  const data = useMemo(() => {
    const parsed = parseTerminalCardData(tool)
    return {
      ...parsed,
      command: sanitizeTerminalDisplayText(parsed.command),
      // Blank lines a shell prints before its first output are not output; a
      // first line's own indent is kept.
      output: sanitizeTerminalDisplayText(parsed.output).replace(/^(?:[ \t]*\n)+/, ''),
      stderr: sanitizeTerminalDisplayText(parsed.stderr)
    }
  }, [tool])
  const output = useMemo(() => markedOutput(data.output), [data.output])
  const running = tool.status === 'running'
  const viewportRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const streamKey = `${data.output.length}:${data.stderr.length}:${data.cwd}:${data.shell}`

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

  // The card header carries the exit code and duration; the body says where
  // it ran only when that is not the workspace itself (a subfolder, a worktree),
  // with the shell beside it, and a session status only when the header has no
  // word for it ("timeout"). Three lines of `cwd / shell / status: done` above
  // every output said nothing new and pushed the output down.
  const { workspacePath } = useRunSession()
  const elsewhere = Boolean(data.cwd) && !(workspacePath && workspacePathsEqual(workspacePath, data.cwd))
  const metaLines: string[] = []
  if (elsewhere) metaLines.push(`cwd: ${data.cwd}`)
  if (elsewhere && data.shell) metaLines.push(`shell: ${data.shell}`)
  if (data.sessionStatus && data.sessionStatus !== 'done' && data.sessionStatus !== 'running') {
    metaLines.push(`status: ${data.sessionStatus}`)
  }

  const hasMeta = metaLines.length > 0
  // The record's terminal card already heads the output with `$ command`; only
  // a lookup row (inGroup), which clips the command at 80 chars, repeats it.
  const hasCommand = Boolean(data.command) && inGroup === true
  const hasStream = Boolean(data.output || data.stderr)

  return (
    <div
      ref={viewportRef}
      data-testid="terminal-viewport"
      role="region"
      aria-label="Terminal output"
      tabIndex={0}
      aria-busy={loading || running || undefined}
      // Inset: the card around it clips an outline (overflow-hidden).
      className={cn(
        TOOL_TERMINAL_VIEWPORT,
        'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus'
      )}
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
          <span className="block text-fg">{`$ ${data.command}`}</span>
        ) : null}
        {hasCommand && hasStream ? <TerminalDivider /> : null}
        {data.output ? <span className="text-secondary">{output}</span> : null}
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
