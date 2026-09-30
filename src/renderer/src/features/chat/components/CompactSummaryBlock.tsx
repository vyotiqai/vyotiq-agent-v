import { useState } from 'react'
import type { CompactionVerifyStatus } from '@shared/transcript'
import { Icon } from '@renderer/lib/icons'
import { MarkdownContent, cn } from '@renderer/lib/ui'
import { formatTokens } from '@renderer/lib/utils/formatTokens'
import { NUM } from '@renderer/lib/utils/layout'
import { ExpandPanel } from '../toolUi/ExpandPanel'
import { firstLinePreview } from '../utils/firstLinePreview'

/** Cap so a long fold summary cannot dominate the record. */
const SUMMARY_BODY_MAX =
  'max-h-[min(16rem,36vh)] sm:max-h-[min(18rem,40vh)] overflow-y-auto overscroll-contain'

function verifyLabel(
  status: CompactionVerifyStatus | undefined,
  coverage: number | undefined
): { text: string; className: string } | null {
  switch (status) {
    case 'verifying':
      return { text: 'Verifying…', className: 'text-tertiary' }
    case 'retrying':
      return { text: 'Retrying…', className: 'text-tertiary' }
    case 'verified': {
      const pct =
        coverage != null && Number.isFinite(coverage) && coverage > 0
          ? ` ${Math.round(coverage * 100)}%`
          : ''
      return { text: `Verified${pct}`, className: 'text-tertiary' }
    }
    case 'failed':
      return { text: 'Failed', className: 'text-danger' }
    default:
      return null
  }
}

function headingForStatus(status: CompactionVerifyStatus | undefined): string {
  switch (status) {
    case 'verifying':
      return 'Verifying summary'
    case 'retrying':
      return 'Retrying summary'
    case 'failed':
      return 'Summary not applied'
    default:
      return 'Context summarised'
  }
}

export function CompactSummaryBlock({
  summary,
  tokenEstimate,
  expanded,
  verifyStatus,
  verifyFailures,
  verifyCoverage
}: {
  summary: string
  tokenEstimate?: number
  expanded?: boolean
  verifyStatus?: CompactionVerifyStatus
  verifyFailures?: string[]
  verifyCoverage?: number
}) {
  const [override, setOverride] = useState<boolean | null>(null)
  // Closed unless asked: in the record only the live step is open.
  const isExpanded = override ?? expanded ?? false
  const preview = firstLinePreview(summary)
  const tokensLabel =
    tokenEstimate != null ? `~${formatTokens(tokenEstimate)}` : null
  const verify = verifyLabel(verifyStatus, verifyCoverage)
  const title = headingForStatus(verifyStatus)
  const failed = verifyStatus === 'failed'

  const heading = tokensLabel ? `${title} ${tokensLabel}` : title

  return (
    <div
      className="w-full min-w-0"
      data-compact-summary
      data-compact-verify={verifyStatus ?? undefined}
    >
      {/* The record's work line: icon, verb, trailing facts, chevron. */}
      <button
        type="button"
        className="group flex min-h-6 w-full items-center gap-2 rounded-sm text-left text-xs focus-visible:vy-focus-ring"
        aria-expanded={isExpanded}
        aria-label={!isExpanded && preview ? `${heading}: ${preview}` : heading}
        title={!isExpanded && preview ? preview : tokensLabel ?? undefined}
        onClick={() => setOverride(!isExpanded)}
      >
        <Icon
          name="collapse"
          size={14}
          className={cn('shrink-0', failed ? 'text-danger' : 'text-muted')}
        />
        <span className={cn('shrink-0 font-medium', failed ? 'text-danger' : 'text-fg')}>{title}</span>
        <span className="flex-1" />
        {verify ? (
          <span className={cn('shrink-0 text-caption', verify.className)}>{verify.text}</span>
        ) : null}
        {tokensLabel ? (
          <span className={cn('shrink-0 text-tertiary', NUM)}>{tokensLabel}</span>
        ) : null}
        <Icon
          name={isExpanded ? 'chevron' : 'chevronRight'}
          size={11}
          className={cn(
            'shrink-0 text-tertiary',
            isExpanded ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
          )}
        />
      </button>
      <ExpandPanel open={isExpanded}>
        <div className={cn('mt-1 border-l border-border pl-3', SUMMARY_BODY_MAX)}>
          {verifyFailures && verifyFailures.length > 0 ? (
            <ul className="mb-2 list-disc space-y-0.5 pl-4 text-caption text-danger">
              {verifyFailures.map((line, i) => (
                <li key={`${i}:${line}`}>{line}</li>
              ))}
            </ul>
          ) : null}
          <MarkdownContent content={summary} streaming={false} tone="secondary" />
        </div>
      </ExpandPanel>
    </div>
  )
}
