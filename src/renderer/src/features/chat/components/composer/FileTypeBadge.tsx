import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { cn } from '@renderer/lib/ui/cn'

export function FileTypeBadge({
  path,
  className,
  size = 'sm'
}: {
  path: string
  className?: string
  size?: 'sm' | 'md'
}) {
  return (
    <FileTypeIcon
      path={path}
      size={size === 'sm' ? 14 : 16}
      className={cn(className)}
    />
  )
}
