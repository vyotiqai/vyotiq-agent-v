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

  // The layout lives on a wrapper inside the Alert: its root is already
  // `flex items-start`, and cn() cannot override that from outside.
  return (
    <Alert variant="info">
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start" data-readiness-layout>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg-strong">{title}</div>
          <div className="mt-0.5 text-xs text-secondary">{body}</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {issue.kind === 'missing_key' ? (
            <Button size="sm" variant="primary" onClick={onAddKey}>
              Add API key
            </Button>
          ) : null}
          {issue.kind === 'unreachable' ? (
            <>
              <Button size="sm" variant="primary" disabled={busy} onClick={onRecheck}>
                Recheck
              </Button>
              <Button size="sm" variant="secondary" onClick={onAddKey}>
                Add API key
              </Button>
            </>
          ) : null}
          {issue.kind === 'manual_catalog' ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={onRecheck}>
              Recheck
            </Button>
          ) : null}
        </div>
      </div>
    </Alert>
  )
}
