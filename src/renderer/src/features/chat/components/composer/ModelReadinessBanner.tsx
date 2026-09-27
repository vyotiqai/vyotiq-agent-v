import { Alert, Button } from '@renderer/lib/ui'
import type { ModelReadinessIssue } from './modelReadiness'

export function ModelReadinessBanner({
  issue,
  busy = false,
  onRecheck,
  onAddKey,
  primary = true
}: {
  issue: ModelReadinessIssue
  busy?: boolean
  onRecheck: () => void
  onAddKey: () => void
  /**
   * The fix is the surface's one action (the instruction line has no other).
   * False on a surface with its own primary, such as the brief's Start task.
   */
  primary?: boolean
}) {
  const lead = primary ? 'primary' : 'secondary'
  const title =
    issue.kind === 'missing_key'
      ? `Add an API key for ${issue.label}`
      : issue.kind === 'unreachable'
        ? `${issue.label} isn’t ready`
        : `${issue.label}: no model list`

  const body =
    issue.kind === 'missing_key'
      ? 'Keys stay encrypted on this device.'
      : issue.detail

  const actions =
    issue.kind === 'missing_key' ? (
      <Button size="sm" variant={lead} onClick={onAddKey}>
        Add API key
      </Button>
    ) : issue.kind === 'unreachable' ? (
      <>
        <Button size="sm" variant={lead} disabled={busy} onClick={onRecheck}>
          Recheck
        </Button>
        <Button size="sm" variant="secondary" onClick={onAddKey}>
          Add API key
        </Button>
      </>
    ) : (
      <Button size="sm" variant={lead} disabled={busy} onClick={onRecheck}>
        Recheck
      </Button>
    )

  return (
    <Alert variant="info" actions={actions}>
      <div className="text-sm font-medium text-fg-strong">{title}</div>
      <div className="mt-0.5 text-xs text-secondary">{body}</div>
    </Alert>
  )
}
