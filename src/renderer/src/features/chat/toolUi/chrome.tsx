import { useMemo } from 'react'
import { toWorkspaceRelPath } from '@shared/utils/workspacePath'
import { cn } from '@renderer/lib/ui'
import { CONTROL_HOVER } from '@renderer/lib/utils/layout'
import { FileBadge } from '../components/FileBadge'
import { useRunSession } from '../RunSessionContext'

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
      // The badge sits on the record's bg-bg card header: the control weight.
      className={cn('shrink-0 rounded-sm vy-transition focus-visible:vy-focus-ring', CONTROL_HOVER)}
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
