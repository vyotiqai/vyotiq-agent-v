import { useEffect, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import type { WorkspaceAgentContextResult } from '@shared/ipc/schemas/agent'

type CodeIndexState = WorkspaceAgentContextResult['codeIndex']['state']

const INDEX_STATE_LABEL: Record<CodeIndexState, string> = {
  ready: 'Ready',
  building: 'Building',
  degraded: 'Degraded',
  off: 'Off'
}

const SKELETON_WIDTHS = ['7.5rem', '9rem', '6.5rem', '7rem']

/**
 * Read-only "what the agent knows" strip for the empty-session state.
 * ONE bridge fetch on mount — no polling, no event subscriptions.
 * IPC failure renders nothing (never fake data).
 */
export function AgentContextCard({ workspacePath }: { workspacePath: string }) {
  const [context, setContext] = useState<WorkspaceAgentContextResult | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Bridge surface is versioned — an older/partial preload without the
    // method must render nothing (never throw inside the effect).
    const request = window.vyotiq.agentContext?.({ workspacePath })
    if (!request) {
      setFailed(true)
      return
    }
    request
      .then((res) => {
        if (cancelled) return
        if (res.ok) setContext(res.data)
        else setFailed(true)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [workspacePath])

  if (failed) return null

  if (!context) {
    return (
      <div className="agent-context-card" data-agent-context-card-skeleton aria-hidden>
        {SKELETON_WIDTHS.map((width) => (
          <span key={width} className="acc-segment acc-skel-chip" style={{ width }} />
        ))}
      </div>
    )
  }

  const { rules } = context
  const ruleChips: string[] = []
  if (rules.agentsMd) ruleChips.push('AGENTS.md')
  if (rules.cursorrules) ruleChips.push('.cursorrules')
  if (rules.vyotiqRulesCount > 0) ruleChips.push(`${rules.vyotiqRulesCount} rules`)

  const state = context.codeIndex.state
  const branch = context.branch

  return (
    <div
      role="group"
      aria-label="What the agent knows"
      data-agent-context-card
      className="agent-context-card"
    >
      <div
        className="acc-segment"
        title={`Workspace: ${context.workspaceName}${branch ? ` · branch ${branch}` : ''}`}
      >
        <Icon name="folder" size={12} className="acc-icon" />
        <span className="acc-text acc-text-primary">{context.workspaceName}</span>
        {branch ? (
          <>
            <span className="acc-text" aria-hidden>
              ·
            </span>
            <Icon name="branch" size={12} className="acc-icon" />
            <span className="acc-text">{branch}</span>
          </>
        ) : null}
      </div>

      <span className="acc-sep" aria-hidden />

      <div
        className="acc-segment"
        title={`Project rules the agent reads: ${ruleChips.length > 0 ? ruleChips.join(', ') : 'none detected'}`}
      >
        <Icon name="check" size={12} className="acc-icon" />
        {ruleChips.length > 0 ? (
          ruleChips.map((chip) => (
            <span key={chip} className="acc-text">
              {chip}
            </span>
          ))
        ) : (
          <span className="acc-text">None</span>
        )}
      </div>

      <span className="acc-sep" aria-hidden />

      <div
        className="acc-segment"
        title={`${context.memoryNotes} memory note${context.memoryNotes === 1 ? '' : 's'} stored for this workspace`}
      >
        <Icon name="memory" size={12} className="acc-icon" />
        <span className="acc-text">
          {context.memoryNotes} memory note{context.memoryNotes === 1 ? '' : 's'}
        </span>
      </div>

      <span className="acc-sep" aria-hidden />

      <div
        className="acc-segment"
        title={`Code index: ${INDEX_STATE_LABEL[state]}${state === 'building' ? ' (embedding in progress)' : ''}`}
      >
        <Icon name="scanSearch" size={12} className="acc-icon" />
        <span className={`acc-dot acc-dot-${state}`} aria-hidden />
        <span className="acc-text">Index: {INDEX_STATE_LABEL[state]}</span>
      </div>
    </div>
  )
}
