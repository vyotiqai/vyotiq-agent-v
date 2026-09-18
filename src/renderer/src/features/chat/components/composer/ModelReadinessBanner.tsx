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

  return (
    <Alert variant="info" className="flex-col items-stretch gap-2 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg-strong">{title}</div>
        <div className="mt-0.5 text-xs text-secondary">{body}</div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {issue.kind === 'missing_key' ? (
          <Button type="button" className="min-h-8 px-2 text-xs" onClick={onAddKey}>
            Add API key
          </Button>
        ) : null}
        {issue.kind === 'unreachable' ? (
          <>
            <Button
              type="button"
              className="min-h-8 px-2 text-xs"
              disabled={busy}
              onClick={onRecheck}
            >
              Recheck
            </Button>
            <Button type="button" variant="subtle" className="min-h-8 px-2 text-xs" onClick={onAddKey}>
              Add API key
            </Button>
          </>
        ) : null}
        {issue.kind === 'manual_catalog' ? (
          <Button
            type="button"
            className="min-h-8 px-2 text-xs"
            disabled={busy}
            onClick={onRecheck}
          >
            Recheck
          </Button>
        ) : null}
      </div>
    </Alert>
  )
}
