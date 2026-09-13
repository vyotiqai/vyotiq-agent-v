import { memo } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { formatUrlLabel } from '@shared/utils/displayPath'
import {
  DISCLOSURE_CHEVRON,
  DISCLOSURE_ROW,
  TOOL_BODY_CLAMP_PX,
  TOOL_CARD_BODY,
  TOOL_CARD_HEADER,
  TOOL_CARD_SURFACE
} from '@renderer/lib/utils/layout'
import { FileBadge } from '../components/FileBadge'
import { TextShimmer } from '../components/TextShimmer'
import { ExpandPanel } from './ExpandPanel'
import { useRunSession } from '../RunSessionContext'

export type ToolCardFoldMode = 'peek' | 'panel'

export function ProminentChrome({
  header,
  body,
  expanded,
  hasBody,
  running,
  foldMode = 'peek',
  clampWhenCollapsed = true,
  ariaLabel,
  onToggle
}: {
  header: React.ReactNode
  body: React.ReactNode
  expanded: boolean
  hasBody: boolean
  running: boolean
  /**
   * `peek` — always-mounted clamped preview (reads/diffs).
   * `panel` — ExpandPanel fold like groups / Thought (terminals, etc.).
   */
  foldMode?: ToolCardFoldMode
  /** When false, the collapsed peek is not height-clamped (e.g. live diffs). */
  clampWhenCollapsed?: boolean
  ariaLabel?: string
  onToggle: () => void
}) {
  const bodyShell =
    hasBody && body ? (
      foldMode === 'panel' ? (
        <ExpandPanel open={expanded}>
          <div className={TOOL_CARD_BODY} data-tool-card-body="">
            {body}
          </div>
        </ExpandPanel>
      ) : (
        <div
          className={cn(TOOL_CARD_BODY, !expanded && clampWhenCollapsed && 'mask-fade-bottom')}
          style={
            !expanded && clampWhenCollapsed ? { maxHeight: TOOL_BODY_CLAMP_PX } : undefined
          }
          // Body owns scrolling (e.g. terminal viewport); avoid a second scrollport.
          data-tool-card-body=""
        >
          {body}
        </div>
      )
    ) : null

  return (
    <div className={cn(TOOL_CARD_SURFACE, 'w-full')} aria-busy={running || undefined}>
      <button
        type="button"
        className={cn(
          TOOL_CARD_HEADER,
          'group flex w-full items-center gap-2 text-left vy-transition',
          hasBody && 'hover:bg-surface/60'
        )}
        onClick={onToggle}
        aria-label={ariaLabel}
        aria-expanded={hasBody ? expanded : undefined}
        disabled={!hasBody}
      >
        {header}
        {hasBody ? (
          <Icon
            name="chevronRight"
            size={14}
            className={cn(DISCLOSURE_CHEVRON, expanded && 'rotate-90')}
          />
        ) : null}
      </button>
      {bodyShell}
    </div>
  )
}

export const CompactRow = memo(function CompactRow({
  title,
  subtitle,
  status,
  expanded,
  hasBody = true,
  interrupted = false,
  icon,
  filePath,
  statusDot,
  onToggle
}: {
  title: string
  subtitle: string
  status: 'running' | 'done' | 'fail'
  expanded: boolean
  hasBody?: boolean
  interrupted?: boolean
  icon?: IconName
  /** Material file-type icon when the row targets a real path. */
  filePath?: string
  statusDot?: 'running' | 'done' | 'fail'
  onToggle: () => void
}) {
  const { onOpenWorkspaceFile } = useRunSession()
  const disclosureLabel = hasBody
    ? `${expanded ? 'Collapse' : 'Expand'} ${title}${subtitle ? `: ${subtitle}` : ''}`
    : title
  const fileBadge =
    filePath && onOpenWorkspaceFile ? (
      <button
        type="button"
        className="shrink-0 rounded-sm vy-transition hover:bg-surface-2/80"
        aria-label={`Open ${filePath}`}
        title={filePath}
        onClick={() => onOpenWorkspaceFile(filePath)}
      >
        <FileBadge path={filePath} />
      </button>
    ) : filePath ? (
      <FileBadge path={filePath} />
    ) : icon ? (
      <Icon name={icon} size={14} className="shrink-0 text-tertiary" />
    ) : null
  return (
    <div className={cn(DISCLOSURE_ROW, 'group w-full', !hasBody && 'cursor-default')}>
      {fileBadge}
      <button
        type="button"
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 text-left',
          !hasBody && 'cursor-default'
        )}
        aria-label={disclosureLabel}
        aria-expanded={hasBody ? expanded : undefined}
        disabled={!hasBody}
        onClick={onToggle}
      >
        <span
          className={cn(
            'flex shrink-0 items-center gap-1.5 font-medium tool-status-morph',
            interrupted || status === 'fail' ? 'text-danger' : 'text-fg'
          )}
        >
          {statusDot ? (
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                statusDot === 'running' && 'bg-tertiary',
                statusDot === 'done' && 'bg-success',
                statusDot === 'fail' && 'bg-danger'
              )}
            />
          ) : null}
          {status === 'running' ? <TextShimmer>{title}</TextShimmer> : title}
        </span>
        {subtitle ? (
          <span className="min-w-0 flex-1 truncate text-secondary" title={subtitle}>
            {formatUrlLabel(subtitle)}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {interrupted ? <span className="text-danger">interrupted</span> : null}
          {!interrupted && status === 'fail' ? (
            <Icon
              name="warning"
              size={14}
              className="shrink-0 text-danger tool-status-morph"
            />
          ) : null}
          {hasBody ? (
            <Icon
              name="chevronRight"
              size={14}
              className={cn(DISCLOSURE_CHEVRON, expanded && 'rotate-90')}
            />
          ) : null}
        </span>
      </button>
    </div>
  )
})
