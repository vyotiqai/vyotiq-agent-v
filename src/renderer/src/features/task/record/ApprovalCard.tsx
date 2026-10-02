import { memo, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ToolApprovalDecision } from '@shared/ipc'
import type { UiToolApproval } from '@shared/transcript'
import { TERMINAL_DEFAULT_TIMEOUT_MS, TOOL_APPROVAL_TIMEOUT_MS } from '@shared/agentTimeouts'
import { parseArgsRecord, parseMcpToolDisplay } from '@shared/toolSummary'
import { Icon } from '@renderer/lib/icons'
import { Button, StatusGlyph, cn, pushToast } from '@renderer/lib/ui'
import { requestOpenSettings } from '@renderer/app/openSettings'
import { QUESTION_GATE_HEADER, QUESTION_GATE_SURFACE } from '@renderer/lib/utils/layout'
import { useSharedNow } from '@renderer/lib/hooks/useSharedNow'
import { altChordLabel } from '@renderer/lib/shortcuts/labels'
import { typingElsewhere } from '@renderer/lib/a11y'
import { toolLabel } from '@renderer/features/chat/toolUi'
import { RecordActionsContext, plainProse } from './WorkItems'
import { TickedText } from './TickedText'

const FILE_TOOLS = new Set(['edit', 'str_replace', 'delete', 'edit_notebook', 'memory_write'])

/** "run a command?" — the thing in plain words, never the running verb. */
export function approvalTitle(approval: UiToolApproval, serverNames?: ReadonlyMap<string, string>): string {
  const name = approval.toolName
  if (name === 'terminal') return 'run a command?'
  if (FILE_TOOLS.has(name)) return name === 'delete' ? 'delete a file?' : 'change a file?'
  if (name.startsWith('browser_')) return 'use the browser?'
  const mcp = parseMcpToolDisplay(name)
  if (mcp) return `use ${serverNames?.get(mcp.serverId) ?? mcp.serverId} · ${mcp.toolName}?`
  return `use ${toolLabel(name, 'done').toLowerCase()}?`
}

/**
 * "Always allowed pnpm vitest": a rule now runs it without asking, so say so
 * once, and where that rule lives.
 */
function sayAlwaysAllowed(approval: UiToolApproval): void {
  const what = approval.toolName === 'terminal' ? approval.alwaysAllowCommand : approval.toolName
  if (!what) return
  pushToast(`Always allowed ${what}`, {
    detail: 'In this workspace · Settings › Agent',
    icon: 'shield',
    action: { label: 'Settings', onClick: () => requestOpenSettings('agent') }
  })
}

function minutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m <= 1 ? '1 min' : `${m} min`
}

/**
 * The one accent block on the page. It sits at the top of the record, not
 * where the step is: "what does this task want from me?" must be answered
 * without scrolling. The step row points up at it.
 */
export const ApprovalCard = memo(function ApprovalCard({
  approval,
  stepLabel,
  requestedAt,
  why,
  onDecide,
  captureFocus = true
}: {
  approval: UiToolApproval
  /** "Step 4 · Verify with the stream tests", when the call belongs to a step. */
  stepLabel?: string
  /** When the request started waiting (ms). */
  requestedAt: number | null
  /** What the agent said just before asking, when it said anything. */
  why?: string
  onDecide?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
  /** Focus Allow once only in the focused pane. */
  captureFocus?: boolean
}) {
  const [phase, setPhase] = useState<'idle' | 'pending' | 'done'>('idle')
  const [pendingDecision, setPendingDecision] = useState<ToolApprovalDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showArgs, setShowArgs] = useState(false)
  const allowRef = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )
  const now = useSharedNow(requestedAt != null)
  const { mcpServerNames } = useContext(RecordActionsContext)

  const decide = useCallback(
    (decision: ToolApprovalDecision): void => {
      if (phase !== 'idle' || !onDecide) return
      setPhase('pending')
      setPendingDecision(decision)
      setError(null)
      void Promise.resolve(onDecide(approval.requestId, decision))
        .then(() => {
          if (decision === 'always') sayAlwaysAllowed(approval)
          if (mounted.current) setPhase('done')
        })
        .catch((err: unknown) => {
          if (!mounted.current) return
          setPhase('idle')
          setPendingDecision(null)
          setError(err instanceof Error ? err.message : 'Could not send your decision.')
        })
    },
    [phase, onDecide, approval]
  )

  const canDecide = Boolean(onDecide) && phase === 'idle'

  // Focus Allow once per request — never again because a parent re-rendered
  // (a new `onDecide` each keystroke), and never out from under text being
  // typed elsewhere: the next space would press Allow for the typist.
  const canFocus = Boolean(onDecide) && captureFocus
  useEffect(() => {
    const allow = allowRef.current
    if (!canFocus || !allow || typingElsewhere(allow.closest('[data-tool-approval]') ?? allow)) return
    allow.focus({ preventScroll: true })
  }, [approval.requestId, canFocus])

  // Alt A allows once, Alt D denies — Esc is left to stop the run.
  useEffect(() => {
    if (!canDecide || !captureFocus) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return
      // The physical key: on macOS Option+A types "å", so `e.key` is never "a".
      const key = e.code === 'KeyA' ? 'a' : e.code === 'KeyD' ? 'd' : e.key.toLowerCase()
      if (key !== 'a' && key !== 'd') return
      e.preventDefault()
      decide(key === 'a' ? 'once' : 'deny')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canDecide, captureFocus, decide])

  const args = parseArgsRecord(approval.argsPreview)
  const isCommand = approval.toolName === 'terminal'
  // The terminal's "Always allow" is per command, as main scoped it; a command
  // that chains or redirects cannot be, so it is not offered at all.
  // A command the guard stopped is asked one run at a time: no standing grants.
  const guarded = Boolean(approval.danger)
  const alwaysAllows = guarded ? null : isCommand ? (approval.alwaysAllowCommand ?? null) : approval.toolName
  const command = isCommand ? (typeof args?.command === 'string' ? args.command : approval.summary) : null
  const target = !isCommand && typeof args?.path === 'string' ? args.path : approval.summary

  const facts: string[] = [approval.mutating ? 'Can change files or run code' : 'Reads only']
  if (isCommand) {
    const cwd = typeof args?.working_directory === 'string' && args.working_directory ? args.working_directory : null
    if (cwd) facts.push(`in ${cwd}`)
    const timeout = typeof args?.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : TERMINAL_DEFAULT_TIMEOUT_MS
    facts.push(`times out after ${minutes(timeout)}`)
  }
  if (requestedAt != null) {
    const left = requestedAt + TOOL_APPROVAL_TIMEOUT_MS - now
    facts.push(left > 0 ? `denied automatically in ${minutes(left)}` : 'denying now')
  }
  const age = requestedAt != null ? Math.max(0, Math.floor((now - requestedAt) / 60_000)) : null
  const pendingText = (d: ToolApprovalDecision, text: string): string =>
    pendingDecision === d && phase === 'pending' ? 'Sending…' : text

  return (
    <section
      aria-label="Needs you"
      data-needs-you
      data-tool-approval=""
      aria-busy={phase === 'pending' || undefined}
      className={cn(QUESTION_GATE_SURFACE, '@container scroll-mt-4 vy-rise')}
    >
      <div className={QUESTION_GATE_HEADER}>
        <StatusGlyph state="needs" size={12} />
        <span className="font-semibold text-accent">Needs you — {approvalTitle(approval, mcpServerNames)}</span>
        <span className="flex-1" />
        {stepLabel ? <span className="min-w-0 truncate text-muted">{stepLabel}</span> : null}
        {age != null ? (
          <span className="shrink-0 font-mono text-caption text-tertiary tnum">{age < 1 ? 'just now' : `${age}m ago`}</span>
        ) : null}
      </div>
      <div className="space-y-3 px-3 py-3">
        {/* The agent's words are markdown; quoted here as text, without their asterisks. */}
        {why ? (
          <p className="line-clamp-3 whitespace-pre-line text-sm text-fg">
            <TickedText text={plainProse(why)} code="rounded-sm bg-surface px-1 py-0.5 font-mono text-[0.85em]" />
          </p>
        ) : null}
        <pre className="scroll-thin overflow-x-auto rounded-md border border-border bg-sunken px-3 py-2 font-mono text-xs leading-[18px] text-fg-strong">
          {command != null ? (
            <>
              <span className="select-none text-tertiary">$ </span>
              {command}
            </>
          ) : (
            target
          )}
        </pre>
        {approval.danger ? (
          <p className="flex items-start gap-1.5 text-xs text-danger" data-approval-danger="">
            <Icon name="warning" size={13} className="mt-px shrink-0" aria-hidden />
            <span className="min-w-0">{approval.danger}. Asks whatever the approval settings say.</span>
          </p>
        ) : null}
        <p className="text-xs text-muted">{facts.join(' · ')}</p>
        {approval.argsPreview && !isCommand ? (
          <div>
            <button
              type="button"
              onClick={() => setShowArgs((v) => !v)}
              aria-expanded={showArgs}
              className="rounded-sm text-caption text-tertiary hover:text-fg focus-visible:vy-focus-ring"
            >
              {showArgs ? 'Hide the full request' : 'Show the full request'}
            </button>
            {showArgs ? (
              <pre className="scroll-thin mt-1 max-h-40 overflow-auto rounded-md bg-sunken px-3 py-2 font-mono text-caption text-secondary">
                {approval.argsPreview}
              </pre>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Button
            ref={allowRef}
            variant="primary"
            size="sm"
            icon="check"
            title={`Allow once (${altChordLabel('a')})`}
            aria-keyshortcuts="Alt+A"
            disabled={!canDecide}
            onClick={() => decide('once')}
          >
            {pendingText('once', 'Allow once')}
          </Button>
          {guarded ? null : (
            <Button size="sm" disabled={!canDecide} onClick={() => decide('session')} title="Allowed for the rest of this task, follow-ups included">
              {pendingText('session', 'Allow for this task')}
            </Button>
          )}
          {/* Always shown: hiding it below a width left no way to choose it in
              a normal window with the inspector open. The row wraps instead. */}
          {alwaysAllows ? (
            <span className="inline-flex">
              <Button
                size="sm"
                variant="ghost"
                disabled={!canDecide}
                title={
                  isCommand
                    ? `Runs ${alwaysAllows} commands in this workspace without asking — never one that chains or redirects`
                    : `Runs ${alwaysAllows} in this workspace without asking`
                }
                onClick={() => decide('always')}
              >
                {pendingDecision === 'always' && phase === 'pending' ? (
                  'Sending…'
                ) : (
                  <>
                    Always allow <code className="font-mono text-caption">{alwaysAllows}</code>
                  </>
                )}
              </Button>
            </span>
          ) : null}
          <span className="flex-1" />
          <Button
            size="sm"
            variant="danger"
            title={`Deny (${altChordLabel('d')})`}
            aria-keyshortcuts="Alt+D"
            disabled={!canDecide}
            onClick={() => decide('deny')}
          >
            {pendingText('deny', 'Deny')}
          </Button>
        </div>
      </div>
    </section>
  )
})
