import { Alert, Button } from '@renderer/lib/ui'
import type { ModelReadinessIssue } from './modelReadiness'

export function ModelReadinessBanner({
  issue,
  busy = false,
  onRecheck,
  onAddKey
}: {
  issue: ModelReadinessIssue
  busy?: boolean
  onRecheck: () => void
  onAddKey: () => void
}) {
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
      <Button size="sm" variant="primary" onClick={onAddKey}>
        Add API key
      </Button>
    ) : issue.kind === 'unreachable' ? (
      <>
        <Button size="sm" variant="primary" disabled={busy} onClick={onRecheck}>
          Recheck
        </Button>
        <Button size="sm" variant="secondary" onClick={onAddKey}>
          Add API key
        </Button>
      </>
    ) : (
      <Button size="sm" variant="primary" disabled={busy} onClick={onRecheck}>
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
