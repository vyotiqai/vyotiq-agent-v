import { memo, useMemo, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { formatUrlLabel } from '@shared/utils/displayPath'
import { TextShimmer } from './TextShimmer'
import type { ToolItem } from '../utils/transcriptRows'
import {
  ProminentChrome,
  ToolBodyView,
  ToolFileBadge,
  ToolPanelIcon,
  getToolHeaderMeta,
  toolDefaultExpanded,
  toolHasBody,
  toolUsesPeekCollapse,
  type ToolBodyTiming
} from '../toolUi'

export const ToolCard = memo(function ToolCard({
  item,
  expanded,
  onToggle,
  onLoadFullContent,
  mcpServerNames
}: {
  item: ToolItem
  expanded?: boolean
  onToggle?: (next: boolean) => void
  onLoadFullContent?: (toolCallId: string) => Promise<string | null>
  mcpServerNames?: ReadonlyMap<string, string>
}) {
  const { tool } = item
  const [localOverride, setLocalOverride] = useState<boolean | null>(null)
  const isOpen = expanded ?? localOverride ?? toolDefaultExpanded(tool.name, tool.status)
  const failed = tool.status === 'fail'
  const running = tool.status === 'running'

  const headerMeta = useMemo(
    () =>
      getToolHeaderMeta(tool, {
        toolProgress: item.toolProgress
      }),
    [tool, item.toolProgress]
  )
  const hasBody = useMemo(
    () =>
      toolHasBody(tool, {
        toolProgress: item.toolProgress
      }),
    [tool, item.toolProgress]
  )
  /**
   * Green only when the tool reported success AND no non-zero exit code. A
   * masked shell (trailing string literal) reports exit_code 0 on a failed run,
   * so `failed` is the authority, not the code alone.
   */
  const isReallyOk = !failed && (headerMeta.exitCode == null || headerMeta.exitCode === 0)
  /**
   * Wall-clock only from groupTiming. Bare `item.at` invents a startedAt without
   * endedAt on non-lead tools, which hides TerminalBody cwd/shell and duration.
   */
  const timing = useMemo((): ToolBodyTiming | undefined => {
    const startedAt = item.groupTiming?.startedAt
    if (startedAt == null || !Number.isFinite(startedAt)) return undefined
    return {
      startedAt,
      endedAt: item.groupTiming?.endedAt
    }
  }, [item.groupTiming?.startedAt, item.groupTiming?.endedAt])

  const toggle = (): void => {
    const next = !isOpen
    if (onToggle) onToggle(next)
    else setLocalOverride(next)
  }

  const disclosureLabel = hasBody
    ? `${isOpen ? 'Collapse' : 'Expand'} ${headerMeta.verb}${
        headerMeta.target ? `: ${headerMeta.target}` : ''
      }`
    : `${headerMeta.verb}${headerMeta.target ? ` ${headerMeta.target}` : ''}`

  /**
   * Rendered outside the disclosure button by ProminentChrome: the badge is
   * itself a button (open in Files), and nesting one is invalid HTML.
   */
  const leading = headerMeta.filePath ? (
    <ToolFileBadge filePath={headerMeta.filePath} fileLine={headerMeta.fileLine} size={16} />
  ) : headerMeta.icon && headerMeta.opensPanel ? (
    <ToolPanelIcon
      icon={headerMeta.icon}
      panel={headerMeta.opensPanel}
      label={`${headerMeta.verb} — open panel`}
    />
  ) : null

  const header = (
    <>
      {!headerMeta.filePath && !headerMeta.opensPanel && headerMeta.icon ? (
        <Icon
          name={headerMeta.icon}
          size={14}
          className={cn('shrink-0', failed ? 'text-danger' : 'text-tertiary')}
        />
      ) : null}
      {running ? (
        <TextShimmer className="shrink-0 max-w-[70%] truncate font-medium text-fg">
          {headerMeta.verb}
        </TextShimmer>
      ) : (
        <span
          className={cn(
            // A long (malformed/recovered) tool name must ellipsize instead of
            // blowing the row out horizontally; short verbs never hit the cap.
            'shrink-0 max-w-[70%] truncate font-medium tool-status-morph',
            failed ? 'text-danger' : 'text-fg'
          )}
        >
          {headerMeta.verb}
        </span>
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-secondary',
          // Command snippets stay mono; free-form edit paths use the default UI face.
          headerMeta.icon === 'terminal' && 'font-mono text-caption'
        )}
        title={headerMeta.target}
      >
        {formatUrlLabel(headerMeta.target)}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
        {failed && headerMeta.exitCode == null ? (
          <Icon name="warning" size={14} className="shrink-0 text-danger tool-status-morph" />
        ) : null}
        {headerMeta.exitCode != null ? (
          <span
            className={cn(
              'rounded-sm px-1 text-2xs',
              // A failed tool is never green: a masked shell (trailing string
              // literal) reports exit_code 0 while the run actually failed.
              isReallyOk ? 'text-success' : 'text-danger'
            )}
            title={
              isReallyOk
                ? `Exit code ${headerMeta.exitCode}`
                : `Exit code ${headerMeta.exitCode} — reported as failed`
            }
          >
            {isReallyOk ? 'exit 0' : `failed (${headerMeta.exitCode})`}
          </span>
        ) : null}
        {!failed && headerMeta.added != null && headerMeta.added > 0 ? (
          <span className="text-success">+{headerMeta.added}</span>
        ) : null}
        {!failed && headerMeta.removed != null && headerMeta.removed > 0 ? (
          <span className="text-danger">-{headerMeta.removed}</span>
        ) : null}
      </span>
    </>
  )

  const foldMode = toolUsesPeekCollapse(tool.name) ? 'peek' : 'panel'

  return (
    <ProminentChrome
      header={header}
      leading={leading}
      foldMode={foldMode}
      // Peek only: live diffs use followEnd — clamping would hide newest lines.
      // DiffPreview still self-limits to the 14-line peek while collapsed.
      clampWhenCollapsed={foldMode === 'peek' ? !running : true}
      ariaLabel={disclosureLabel}
      body={
        <ToolBodyView
          context={{
            tool,
            expanded: isOpen,
            toolProgress: item.toolProgress,
            onLoadFullContent,
            mcpServerNames,
            timing
          }}
        />
      }
      expanded={isOpen}
      hasBody={hasBody}
      running={running}
      onToggle={toggle}
    />
  )
})
