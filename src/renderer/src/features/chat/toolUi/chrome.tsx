import { memo, useMemo } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import type { ChatRightPanelId } from '@renderer/lib/utils/layout'
import { cn } from '@renderer/lib/ui'
import { formatUrlLabel } from '@shared/utils/displayPath'
import { toWorkspaceRelPath } from '@shared/utils/workspacePath'
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

/**
 * File-type badge that opens the tool's target in the Files panel.
 *
 * The tool reports whatever path the model sent, which may be absolute; the
 * workspace file IPC only accepts workspace-relative paths. Anything that will
 * not resolve inside the open workspace renders as an inert badge rather than
 * a link that fails on click.
 */
export function ToolFileBadge({
  filePath,
  fileLine,
  size = 14
}: {
  filePath: string
  /** 1-based line to land on, when the tool reported one. */
  fileLine?: number
  size?: number
}) {
  const { workspacePath, onOpenWorkspaceFile } = useRunSession()
  const relPath = useMemo(
    () => toWorkspaceRelPath(workspacePath, filePath),
    [workspacePath, filePath]
  )

  if (!relPath || !onOpenWorkspaceFile) {
    return <FileBadge path={filePath} size={size} />
  }

  const target = fileLine != null ? `${relPath}:${fileLine}` : relPath
  return (
    <button
      type="button"
      className="shrink-0 rounded-sm vy-transition hover:bg-surface-2 focus-visible:vy-focus-ring"
      aria-label={`Open ${target}`}
      title={`Open ${target}`}
      onClick={() => {
        // Keep the no-line call single-argument: that is the existing contract
        // every other caller of onOpenWorkspaceFile uses.
        if (fileLine != null) onOpenWorkspaceFile(relPath, { line: fileLine })
        else onOpenWorkspaceFile(relPath)
      }}
    >
      <FileBadge path={relPath} size={size} />
    </button>
  )
}

/**
 * Leading icon that reveals a dock panel — for tools whose result lives in a
 * panel rather than a file. Falls back to a plain icon when the host provides
 * no panel opener (instance panes, tests).
 */
export function ToolPanelIcon({
  icon,
  panel,
  label,
  className
}: {
  icon: IconName
  panel: ChatRightPanelId
  /** Accessible name, e.g. "Open pull request panel". */
  label: string
  className?: string
}) {
  const { onOpenPanel } = useRunSession()
  if (!onOpenPanel) {
    return <Icon name={icon} size={14} className={cn('shrink-0 text-tertiary', className)} />
  }
  return (
    <button
      type="button"
      className="shrink-0 rounded-sm vy-transition hover:bg-surface-2 focus-visible:vy-focus-ring"
      aria-label={label}
      title={label}
      onClick={() => onOpenPanel(panel)}
    >
      <Icon name={icon} size={14} className={cn('shrink-0 text-tertiary', className)} />
    </button>
  )
}

export function ProminentChrome({
  header,
  leading,
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
  /**
   * Interactive chrome that sits before the header, outside the disclosure
   * button — a nested button would be invalid HTML.
   */
  leading?: React.ReactNode
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
      <div
        className={cn(
          'group flex w-full items-center vy-transition',
          hasBody && 'hover:bg-surface'
        )}
      >
        {leading ? <span className="flex shrink-0 items-center pl-3">{leading}</span> : null}
        <button
          type="button"
          className={cn(
            TOOL_CARD_HEADER,
            'flex min-w-0 flex-1 items-center gap-2 text-left',
            // The badge already carries the left inset; keep the 8px gap only.
            Boolean(leading) && 'pl-2'
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
      </div>
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
  fileLine,
  opensPanel,
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
  /** 1-based line to land on when the badge opens the file. */
  fileLine?: number
  /** Dock panel the leading icon reveals, when the result lives in one. */
  opensPanel?: ChatRightPanelId
  statusDot?: 'running' | 'done' | 'fail'
  onToggle: () => void
}) {
  const disclosureLabel = hasBody
    ? `${expanded ? 'Collapse' : 'Expand'} ${title}${subtitle ? `: ${subtitle}` : ''}`
    : title
  const fileBadge = filePath ? (
    <ToolFileBadge filePath={filePath} fileLine={fileLine} />
  ) : icon && opensPanel ? (
    <ToolPanelIcon icon={icon} panel={opensPanel} label={`${title} — open panel`} />
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
