import { useMemo } from 'react'
import { TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import { formatListDirPathLabel } from '@shared/utils/displayPath'
import type { ToolBodyProps } from '../types'
import { parseListDirData } from '../parsers/listDir'
import { DirListing, TruncatedBanner } from '../primitives'

/** Quiet section label — distinguishes directory listings from Files Changed receipts. */
const DIR_SECTION_LABEL =
  'text-2xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-tertiary'

export function ListDirBody({ tool, loading, loadFailed, inGroup }: ToolBodyProps) {
  const data = useMemo(() => parseListDirData(tool), [tool])
  const pathLabel = formatListDirPathLabel(data.path)
  const countLabel =
    data.totalEntries > 0
      ? `${data.totalEntries} ${data.totalEntries === 1 ? 'item' : 'items'}`
      : null

  // In a tool group the path already lives on the CompactRow title — keep the
  // Directory chrome without repeating the path string.
  const detail = inGroup
    ? [countLabel, data.truncated ? 'truncated' : null].filter(Boolean).join(' · ')
    : `${pathLabel}${countLabel ? ` — ${countLabel}` : ''}${data.truncated ? ' (truncated)' : ''}`

  return (
    <div data-tool-body="list_dir">
      <div className={`${TOOL_BODY_PAD} flex flex-col gap-0.5 pb-1`}>
        <span className={DIR_SECTION_LABEL}>Directory</span>
        {detail ? <span className="font-mono text-2xs text-tertiary">{detail}</span> : null}
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      <DirListing entries={data.entries} basePath={data.path} />
    </div>
  )
}
