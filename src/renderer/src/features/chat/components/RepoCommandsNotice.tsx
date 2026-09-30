import { useState, type JSX } from 'react'
import { Icon } from '@renderer/lib/icons'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { Button, cn } from '@renderer/lib/ui'
import type { GitStatus } from '@shared/ipc'

/**
 * Programs this repository's own git settings name, which Vyotiq's git skips:
 * a folder someone hands you carries its `.git/config`, and git would run
 * them on a plain status read. Listed as the settings say them, so the person
 * can tell git-crypt from something they never set up before allowing it.
 */
export function RepoCommandsNotice({
  workspacePath,
  repoCommands,
  inset,
  onAllowed
}: {
  workspacePath: string
  repoCommands: NonNullable<GitStatus['repoCommands']>
  /** The pane's row inset: 16px in the review, 12px in the tab. */
  inset: 'px-3' | 'px-4'
  onAllowed: () => void
}): JSX.Element {
  const { confirm, dialog } = useConfirm()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allow = async (): Promise<void> => {
    const confirmed = await confirm(
      "Vyotiq's git will run these whenever it reads this repository. Allow them only if you trust where it came from. A change to them is switched off again.",
      { title: 'Allow for this repository', confirmLabel: 'Allow' }
    )
    if (!confirmed) return
    setBusy(true)
    setError(null)
    const res = await window.vyotiq.gitAllowRepoCommands({ workspacePath })
    setBusy(false)
    if (res.ok) onAllowed()
    else setError(res.error)
  }

  return (
    <div
      className={cn('shrink-0 space-y-1.5 border-b border-border py-2 text-xs', inset)}
      role="status"
      data-repo-commands
    >
      <div className="flex items-center gap-2">
        <Icon name="warning" size={14} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 text-secondary">
          This repository&apos;s git settings run programs. Vyotiq&apos;s git skips them.
        </span>
        {repoCommands.canAllow ? (
          <Button size="xs" disabled={busy} onClick={() => void allow()}>
            Allow for this repo
          </Button>
        ) : null}
      </div>
      <ul className="m-0 list-none space-y-0.5 p-0 pl-[22px]">
        {repoCommands.blocked.map(({ key, value }) => (
          <li key={`${key}\0${value}`} className="flex min-w-0 gap-2 font-mono text-caption">
            <span className="shrink-0 text-muted">{key}</span>
            <span className="min-w-0 truncate text-tertiary" title={value}>
              {value}
            </span>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="m-0 flex items-start gap-2 text-danger" role="alert">
          <Icon name="warningCircle" size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
        </p>
      ) : null}
      {dialog}
    </div>
  )
}
