import { useMemo } from 'react'
import { SECTION_LABEL, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import { formatListDirPathLabel } from '@shared/utils/displayPath'
import type { ToolBodyProps } from '../types'
import { parseListDirData } from '../parsers/listDir'
import { DirListing, TruncatedBanner } from '../primitives'

export function ListDirBody({ tool, loading, loadFailed, inGroup }: ToolBodyProps) {
  const data = useMemo(() => parseListDirData(tool), [tool])
  const pathLabel = formatListDirPathLabel(data.path)
  const countLabel =
    data.totalEntries > 0
      ? `${data.totalEntries} ${data.totalEntries === 1 ? 'item' : 'items'}`
      : null

  // In the record the path already lives on the row — keep the Directory
  // label without repeating the path string.
  const detail = inGroup
    ? [countLabel, data.truncated ? 'truncated' : null].filter(Boolean).join(' · ')
    : `${pathLabel}${countLabel ? ` — ${countLabel}` : ''}${data.truncated ? ' (truncated)' : ''}`

  return (
    <div data-tool-body="list_dir">
      <div className={`${TOOL_BODY_PAD} flex flex-col gap-0.5 pb-1`}>
        <span className={SECTION_LABEL}>Directory</span>
        {detail ? <span className="font-mono text-caption text-tertiary">{detail}</span> : null}
      </div>
      {tool.contentTruncated ? <TruncatedBanner loading={loading} failed={loadFailed} /> : null}
      <DirListing entries={data.entries} basePath={data.path} />
    </div>
  )
}
