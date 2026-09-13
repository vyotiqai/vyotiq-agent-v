import { useState } from 'react'
import type { CompactionVerifyStatus } from '@shared/transcript'
import { Icon } from '@renderer/lib/icons'
import { MarkdownContent, cn } from '@renderer/lib/ui'
import { formatTokens } from '@renderer/lib/utils/formatTokens'
import { DISCLOSURE_CHEVRON, DISCLOSURE_ROW } from '@renderer/lib/utils/layout'
import { ExpandPanel } from '../toolUi/ExpandPanel'
import { firstLinePreview } from '../utils/firstLinePreview'

/** Cap so a long fold summary cannot dominate the transcript. */
const SUMMARY_BODY_MAX =
  'max-h-[min(16rem,36vh)] sm:max-h-[min(18rem,40vh)] overflow-y-auto overscroll-contain'

const SUMMARY_INK =
  '!text-sm !leading-relaxed !text-secondary [&_a]:!underline [&_a]:!decoration-secondary'

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
      return 'Context summarized'
  }
}

export function CompactSummaryBlock({
  summary,
  tokenEstimate,
  expanded,
  onToggle,
  verifyStatus,
  verifyFailures,
  verifyCoverage
}: {
  summary: string
  tokenEstimate?: number
  expanded?: boolean
  onToggle?: (next: boolean) => void
  verifyStatus?: CompactionVerifyStatus
  verifyFailures?: string[]
  verifyCoverage?: number
}) {
  const [override, setOverride] = useState<boolean | null>(null)
  const isExpanded = override ?? expanded ?? true
  const preview = firstLinePreview(summary)
  const tokensLabel =
    tokenEstimate != null ? `~${formatTokens(tokenEstimate)}` : null
  const verify = verifyLabel(verifyStatus, verifyCoverage)
  const title = headingForStatus(verifyStatus)

  const toggle = (): void => {
    const next = !isExpanded
    setOverride(next)
    onToggle?.(next)
  }

  const heading = tokensLabel ? `${title} ${tokensLabel}` : title

  return (
    <div
      className="w-full min-w-0"
      data-compact-summary
      data-compact-verify={verifyStatus ?? undefined}
    >
      <button
        type="button"
        className={cn(DISCLOSURE_ROW, 'group w-full text-left text-secondary')}
        aria-expanded={isExpanded}
        aria-label={!isExpanded && preview ? `${heading}: ${preview}` : heading}
        title={!isExpanded && preview ? preview : tokensLabel ?? undefined}
        onClick={toggle}
      >
        <span className="font-medium text-secondary">{title}</span>
        {verify ? (
          <span className={cn('shrink-0 text-caption', verify.className)}>{verify.text}</span>
        ) : null}
        {tokensLabel ? (
          <span className="shrink-0 text-tertiary tabular-nums">{tokensLabel}</span>
        ) : null}
        <Icon
          name="chevronRight"
          size={14}
          className={cn(DISCLOSURE_CHEVRON, 'text-secondary/80', isExpanded && 'rotate-90')}
        />
      </button>
      <ExpandPanel open={isExpanded}>
        <div className={cn('mt-0.5 border-l border-border pl-3', SUMMARY_BODY_MAX)}>
          {verifyFailures && verifyFailures.length > 0 ? (
            <ul className="mb-2 list-disc space-y-0.5 pl-4 text-caption text-danger">
              {verifyFailures.map((line, i) => (
                <li key={`${i}:${line}`}>{line}</li>
              ))}
            </ul>
          ) : null}
          <MarkdownContent content={summary} streaming={false} className={SUMMARY_INK} />
        </div>
      </ExpandPanel>
    </div>
  )
}
