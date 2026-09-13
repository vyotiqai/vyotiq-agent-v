import { memo } from 'react'
import { FileTypeIcon } from '@renderer/lib/fileIcons'

/**
 * File-type icon for tool cards / changes panels (Material Icon Theme).
 * Kept as `FileBadge` so existing call sites stay stable.
 */
export const FileBadge = memo(function FileBadge({
  path,
  className,
  size = 14
}: {
  path: string
  className?: string
  size?: number
}) {
  return <FileTypeIcon path={path} size={size} className={className} />
})
