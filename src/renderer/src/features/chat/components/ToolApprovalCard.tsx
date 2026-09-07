import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Tooltip, cn } from '@renderer/lib/ui'
import { QUESTION_GATE_BODY, QUESTION_GATE_FOOTER, QUESTION_GATE_HEADER, QUESTION_GATE_SURFACE } from '@renderer/lib/utils/layout'
import type { UiToolApproval } from '@shared/transcript'
import type { ToolApprovalDecision } from '@shared/ipc'
import { toolLabel } from '../toolUi/meta'

const CHOICES: { decision: ToolApprovalDecision; label: string; primary?: boolean }[] = [
  { decision: 'once', label: 'Allow once', primary: true },
  { decision: 'session', label: 'Allow for session' },
  { decision: 'always', label: 'Always allow' }
]

/** Browse-only agent browser tools — egress, not workspace mutation. */
const NETWORK_BROWSE_TOOLS = new Set([
  'browser_search',
  'browser_navigate',
  'browser_snapshot',
  'browser_scroll',
  'browser_tabs',
  'browser_back',
  'browser_forward',
  'browser_wait_for_selector',
  'browser_wait_for_url',
  'browser_wait_for_text',
  'browser_hover'
  // Legacy web_fetch / web_search: transcript-only; not in TOOL_REGISTRY
])

function approvalKindLabel(toolName: string, mutating: boolean): string {
  if (NETWORK_BROWSE_TOOLS.has(toolName)) return 'browse'
  if (mutating) return 'mutating / network'
  return 'read-only'
}

export const ToolApprovalCard = memo(function ToolApprovalCard({
  approval,
  onDecide,
  captureFocus = true
}: {
  approval: UiToolApproval
  onDecide?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
  /** Focus Allow once only on the focused visible pane. */
  captureFocus?: boolean
}) {
  const [phase, setPhase] = useState<'idle' | 'pending' | 'done'>('idle')
  const [pendingDecision, setPendingDecision] = useState<ToolApprovalDecision | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const allowOnceRef = useRef<HTMLButtonElement>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  const decide = useCallback(
    (decision: ToolApprovalDecision): void => {
      if (phase !== 'idle' || !onDecide) return
      setPhase('pending')
      setPendingDecision(decision)
      setLocalError(null)
      void Promise.resolve(onDecide(approval.requestId, decision))
        .then(() => {
          if (!mountedRef.current) return
          // Stay locked; parent usually removes the card on success.
          setPhase('done')
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          setPhase('idle')
          setPendingDecision(null)
          setLocalError(err instanceof Error ? err.message : 'Could not send decision')
        })
    },
    [phase, onDecide, approval.requestId]
  )

  const busy = phase !== 'idle'
  const canDecide = Boolean(onDecide) && !busy
  const label = toolLabel(approval.toolName, 'running')

  useEffect(() => {
    if (!onDecide || !captureFocus) return
    allowOnceRef.current?.focus()
  }, [approval.requestId, onDecide, captureFocus])

  useEffect(() => {
    if (!canDecide || !captureFocus) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (document.querySelector('[aria-expanded="true"][aria-haspopup]')) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      if (document.querySelector('[role="listbox"][aria-label="Slash commands"]')) return
      if (document.querySelector('[role="listbox"][aria-label="Mentions"]')) return
      e.preventDefault()
      e.stopPropagation()
      decide('deny')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canDecide, decide, captureFocus])

  return (
    <div
      className={cn(QUESTION_GATE_SURFACE, 'w-full')}
      role="group"
      data-tool-approval=""
      aria-busy={phase === 'pending' ? true : undefined}
    >
      <div className={cn(QUESTION_GATE_HEADER, 'text-fg')}>
        <Icon name="warning" size={14} className="shrink-0 text-danger" />
        <span className="font-medium">
          Allow tool:{' '}
          <span title={approval.toolName}>{label}</span>?
        </span>
        <span className="min-w-0 truncate text-tertiary" title={approval.summary}>
          {approval.summary}
        </span>
        <span className="ml-auto shrink-0 text-tertiary">
          {approvalKindLabel(approval.toolName, approval.mutating)}
        </span>
      </div>
      {approval.argsPreview ? (
        <pre className={cn(QUESTION_GATE_BODY, 'max-h-40 overflow-auto text-xs text-secondary')}>
          {approval.argsPreview}
        </pre>
      ) : null}
      {localError ? (
        <p className="border-t border-border/40 px-3 py-2 text-xs text-danger" role="alert">
          {localError}
        </p>
      ) : null}
      <div className={cn(QUESTION_GATE_FOOTER, 'flex-wrap border-t border-border/40')}>
        {CHOICES.map((choice) => {
          if (!choice.primary) {
            return (
              <button
                key={choice.decision}
                type="button"
                disabled={!canDecide}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs vy-transition disabled:opacity-[var(--vy-disabled-opacity)]',
                  'border-border text-fg hover:bg-surface'
                )}
                onClick={() => decide(choice.decision)}
              >
                {pendingDecision === choice.decision && phase === 'pending' ? 'Sending…' : choice.label}
              </button>
            )
          }
          return (
            <Tooltip key={choice.decision} content={`${choice.label} (Enter)`}>
              <button
                ref={allowOnceRef}
                type="button"
                disabled={!canDecide}
                className="rounded-md border border-accent bg-accent px-2 py-1 text-xs text-accent-fg vy-transition hover:opacity-90 disabled:opacity-[var(--vy-disabled-opacity)]"
                onClick={() => decide(choice.decision)}
              >
                {pendingDecision === choice.decision && phase === 'pending' ? 'Sending…' : choice.label}
              </button>
            </Tooltip>
          )
        })}
        <Tooltip content="Deny (Esc)">
          <button
            type="button"
            disabled={!canDecide}
            className="ml-auto rounded-md border border-border px-2 py-1 text-xs text-danger vy-transition hover:bg-surface disabled:opacity-[var(--vy-disabled-opacity)]"
            onClick={() => decide('deny')}
          >
            {pendingDecision === 'deny' && phase === 'pending' ? 'Sending…' : 'Deny'}
          </button>
        </Tooltip>
      </div>
    </div>
  )
})
