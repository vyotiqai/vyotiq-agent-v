/**
 * Screenshot-style web-search tool timeline (search tree + sources + reads).
 *
 * Data comes from the sibling parser contract
 * (`toolUi/parsers/webSearchTimeline.ts`): ToolGroup feeds `items` produced by
 * `parseWebSearchTimelineItem`. Rows whose underlying tool keeps its existing
 * body (browser_search / web_fetch) mount the usual ToolRowOutput under the row,
 * so nothing is lost versus the generic nested list; web_search rows replace the
 * old WebSearchBody hits list with the inline Sources disclosure.
 */

import type { UiGroupTiming, UiToolProgressEntry, UiToolRow } from '@shared/transcript'
import { useState, type CSSProperties } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { DISCLOSURE_CHEVRON, DISCLOSURE_ROW } from '@renderer/lib/utils/layout'
import { TextShimmer } from '../components/TextShimmer'
import { ToolRowOutput } from '../components/ToolRow'
import { ExpandPanel } from './ExpandPanel'
import { toolHasBody } from './registry'
import { hostForUrl, SiteBrandIcon, siteBrandForHost } from './siteBrands'

export type WebSearchTimelineSource = {
  title: string
  url: string
}

export type WebSearchTimelineItem = {
  id: string
  kind: 'search' | 'read'
  /** Search phrase (search rows) — rendered in the inline code chip. */
  query: string
  /** Site host the search targeted ('' when generic web). */
  host?: string
  /** Target URL for read (web_fetch) rows. */
  url?: string
  /** Result count — the right-aligned receipt renders only when present. */
  count?: number | null
  sources?: WebSearchTimelineSource[]
  status: UiToolRow['status']
  /** Underlying tool for rows that keep their existing body. */
  tool?: UiToolRow
}

export function WebSearchTimeline({
  items,
  elapsedDisplay,
  live = false,
  isToolExpanded,
  onToolToggle,
  onLoadFullContent,
  mcpServerNames,
  toolProgressById,
  timing
}: {
  items: WebSearchTimelineItem[]
  elapsedDisplay?: string
  live?: boolean
  /** Resolved per-tool expansion for rows that keep their existing body. */
  isToolExpanded?: (toolCallId: string) => boolean
  onToolToggle?: (toolCallId: string, expanded: boolean) => void
  onLoadFullContent?: (toolCallId: string) => Promise<string | null>
  mcpServerNames?: ReadonlyMap<string, string>
  toolProgressById?: ReadonlyMap<string, UiToolProgressEntry[]>
  timing?: UiGroupTiming
}) {
  const running = live || items.some((item) => item.status === 'running')
  const failed = items.some((item) => item.status === 'fail')
  const searchCount = items.filter((item) => item.kind === 'search').length

  return (
    <div
      className="min-w-0 text-xs"
      role="group"
      aria-busy={running || undefined}
      aria-label={`Web search timeline, ${searchCount} searches`}
    >
      <div className="flex items-center gap-1.5 py-1">
        <Icon name="search" size={14} className="shrink-0 text-tertiary" />
        {running ? (
          <TextShimmer className="shrink-0 font-medium text-fg">
            Searching the web…
          </TextShimmer>
        ) : (
          <span
            className={cn(
              'shrink-0 font-medium tool-status-morph',
              failed ? 'text-danger' : 'text-fg'
            )}
          >
            Ran {searchCount} searches
          </span>
        )}
        {failed && !running ? <span className="text-danger">interrupted</span> : null}
        {!running && elapsedDisplay ? (
          <span className="ml-auto shrink-0 tabular-nums text-tertiary">
            {elapsedDisplay}
          </span>
        ) : null}
      </div>
      <div className="relative ml-1.5 flex flex-col border-l border-border/60 pl-3">
        {items.map((item, index) => (
          <TimelineRow
            key={item.id}
            item={item}
            staggerIndex={index}
            isToolExpanded={isToolExpanded}
            onToolToggle={onToolToggle}
            onLoadFullContent={onLoadFullContent}
            mcpServerNames={mcpServerNames}
            toolProgress={toolProgressById?.get(item.tool?.id ?? '')}
            timing={timing}
          />
        ))}
      </div>
    </div>
  )
}

function providerLabelFor(host: string | undefined): string {
  return siteBrandForHost(host)?.label ?? 'the web'
}

function readLabel(item: WebSearchTimelineItem): string {
  const host = hostForUrl(item.url || item.host)
  return host || 'page'
}

function resultCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'result' : 'results'}`
}

function TimelineRow({
  item,
  staggerIndex,
  isToolExpanded,
  onToolToggle,
  onLoadFullContent,
  mcpServerNames,
  toolProgress,
  timing
}: {
  item: WebSearchTimelineItem
  staggerIndex: number
  isToolExpanded?: (toolCallId: string) => boolean
  onToolToggle?: (toolCallId: string, expanded: boolean) => void
  onLoadFullContent?: (toolCallId: string) => Promise<string | null>
  mcpServerNames?: ReadonlyMap<string, string>
  toolProgress?: UiToolProgressEntry[]
  timing?: UiGroupTiming
}) {
  const tool = item.tool
  const hasBody = tool ? toolHasBody(tool, { toolProgress }) : false
  const [localOverride, setLocalOverride] = useState<boolean | null>(null)
  const open = localOverride ?? (tool && isToolExpanded ? isToolExpanded(tool.id) : false)
  const toggleBody = (): void => {
    if (!tool || !hasBody) return
    const next = !open
    if (onToolToggle) onToolToggle(tool.id, next)
    else setLocalOverride(next)
  }

  if (item.kind === 'read') {
    return (
      <div
        className="tool-stagger-enter relative min-w-0 py-1"
        style={{ '--stagger-index': staggerIndex } as CSSProperties}
      >
        <span aria-hidden className="absolute -left-3 top-1/2 h-px w-2.5 bg-border/60" />
        <div
          className={cn(
            'flex min-w-0 items-center gap-1.5',
            hasBody && 'cursor-pointer'
          )}
          onClick={hasBody ? toggleBody : undefined}
          role={hasBody ? 'button' : undefined}
          tabIndex={hasBody ? 0 : undefined}
          aria-expanded={hasBody ? open : undefined}
          aria-label={hasBody ? `${item.status === 'running' ? 'Reading' : 'Read'} ${readLabel(item)}` : undefined}
          onKeyDown={
            hasBody
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    toggleBody()
                  }
                }
              : undefined
          }
        >
          <Icon name="globe" size={14} className="shrink-0 text-tertiary" />
          {item.status === 'running' ? (
            <TextShimmer className="min-w-0 flex-1 text-secondary">
              Reading {readLabel(item)}
            </TextShimmer>
          ) : (
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                item.status === 'fail' ? 'text-danger' : 'text-secondary'
              )}
              title={item.url || item.host}
            >
              {item.status === 'fail' ? 'Reading' : 'Read'} {readLabel(item)}
            </span>
          )}
          {hasBody ? (
            <Icon
              name="chevronRight"
              size={14}
              className={cn(DISCLOSURE_CHEVRON, open && 'rotate-90')}
            />
          ) : null}
        </div>
        {tool ? (
          <ExpandPanel open={hasBody && open}>
            <div className="tool-body-enter">
              <ToolRowOutput
                tool={tool}
                toolProgress={toolProgress}
                onLoadFullContent={onLoadFullContent}
                mcpServerNames={mcpServerNames}
                inGroup
                indent={false}
                timing={timing}
              />
            </div>
          </ExpandPanel>
        ) : null}
      </div>
    )
  }

  const phrase = `${
    item.status === 'running' ? 'Searching' : 'Searched'
  } ${providerLabelFor(item.host)} for`
  const sources = item.sources ?? []

  return (
    <div
      className="tool-stagger-enter relative min-w-0 py-1"
      style={{ '--stagger-index': staggerIndex } as CSSProperties}
    >
      <span aria-hidden className="absolute -left-3 top-1/2 h-px w-2.5 bg-border/60" />
      <div
        className={cn('flex min-w-0 items-center gap-1.5', hasBody && 'cursor-pointer')}
        onClick={hasBody ? toggleBody : undefined}
        role={hasBody ? 'button' : undefined}
        tabIndex={hasBody ? 0 : undefined}
        aria-expanded={hasBody ? open : undefined}
        aria-label={hasBody ? `${phrase} ${item.query}` : undefined}
        onKeyDown={
          hasBody
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  toggleBody()
                }
              }
            : undefined
        }
      >
        <SiteBrandIcon host={item.host} size={14} />
        {item.status === 'running' ? (
          <TextShimmer className="shrink-0 text-secondary">{phrase}</TextShimmer>
        ) : (
          <span
            className={cn(
              'shrink-0',
              item.status === 'fail' ? 'text-danger' : 'text-secondary'
            )}
          >
            {phrase}
          </span>
        )}
        <code
          className="min-w-0 flex-1 truncate rounded bg-surface-2 px-1 py-px font-mono text-2xs text-fg/80"
          title={item.query}
        >
          {item.query}
        </code>
        {item.count != null ? (
          <span className="ml-auto shrink-0 tabular-nums text-2xs text-tertiary">
            {resultCountLabel(item.count)}
          </span>
        ) : null}
        {hasBody ? (
          <Icon
            name="chevronRight"
            size={14}
            className={cn(DISCLOSURE_CHEVRON, open && 'rotate-90')}
          />
        ) : null}
      </div>
      {tool ? (
        <ExpandPanel open={hasBody && open}>
          <div className="tool-body-enter">
            <ToolRowOutput
              tool={tool}
              toolProgress={toolProgress}
              onLoadFullContent={onLoadFullContent}
              mcpServerNames={mcpServerNames}
              inGroup
              indent={false}
              timing={timing}
            />
          </div>
        </ExpandPanel>
      ) : null}
      {sources.length > 0 ? <SourcesRow sources={sources} /> : null}
    </div>
  )
}

const MAX_SOURCE_CHIPS = 5

function SourcesRow({ sources }: { sources: WebSearchTimelineSource[] }) {
  const [open, setOpen] = useState(false)
  const chips = sources.slice(0, MAX_SOURCE_CHIPS)
  return (
    <div className="relative py-0.5 pl-5">
      <button
        type="button"
        className={cn(DISCLOSURE_ROW, 'group w-full gap-1.5 py-0.5 text-left text-2xs')}
        onClick={() => setOpen((next) => !next)}
        aria-expanded={open}
        aria-label={open ? 'Collapse sources' : 'Expand sources'}
      >
        <span className="shrink-0 text-tertiary">Sources</span>
        <span className="flex shrink-0 items-center gap-0.5">
          {chips.map((source, index) => (
            <span
              key={`${source.url}:${index}`}
              className="inline-flex items-center rounded-sm border border-border bg-surface-2/60 p-0.5"
              title={hostForUrl(source.url)}
            >
              <SiteBrandIcon host={hostForUrl(source.url)} size={10} />
            </span>
          ))}
        </span>
        <Icon
          name="chevronRight"
          size={12}
          className={cn(DISCLOSURE_CHEVRON, open && 'rotate-90')}
        />
      </button>
      <ExpandPanel open={open}>
        <ul className="m-0 list-none p-0">
          {sources.map((source, index) => (
            <li
              key={`${source.url}:${index}`}
              className="flex min-w-0 items-center gap-1.5 py-0.5 pl-4 text-2xs"
            >
              <SiteBrandIcon host={hostForUrl(source.url)} size={12} />
              <span
                className="min-w-0 flex-1 truncate text-secondary"
                title={source.title}
              >
                {source.title}
              </span>
              <span className="shrink-0 text-tertiary">{hostForUrl(source.url)}</span>
            </li>
          ))}
        </ul>
      </ExpandPanel>
    </div>
  )
}
