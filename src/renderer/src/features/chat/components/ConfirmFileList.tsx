import { memo } from 'react'

export type ConfirmFileListEntry = {
  path: string
  action?: 'created' | 'modified' | 'deleted'
}

const ACTION_LABEL: Record<NonNullable<ConfirmFileListEntry['action']>, string> = {
  created: 'New',
  modified: 'Modified',
  deleted: 'Deleted'
}

function actionClass(action: NonNullable<ConfirmFileListEntry['action']>): string {
  if (action === 'created') return 'text-success'
  if (action === 'deleted') return 'text-muted'
  return 'text-tertiary'
}

/**
 * Compact flat file list shown inside revert confirmations so the user sees
 * exactly which paths (and directories) are about to be restored.
 */
export const ConfirmFileList = memo(function ConfirmFileList({
  files
}: {
  files: readonly ConfirmFileListEntry[]
}) {
  return (
    <ul className="m-0 max-h-48 list-none overflow-y-auto rounded-md border border-border/50 bg-surface p-0 text-xs">
      {files.map((file) => (
        <li
          key={file.path}
          className="flex min-w-0 items-center gap-2 border-b border-border/40 px-2 py-1 last:border-b-0"
        >
          <span className="min-w-0 truncate font-mono text-fg" title={file.path}>
            {file.path}
          </span>
          {file.action ? (
            <span className={`ml-auto shrink-0 text-2xs ${actionClass(file.action)}`}>
              {ACTION_LABEL[file.action]}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
})
