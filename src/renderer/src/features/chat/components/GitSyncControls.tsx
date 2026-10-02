import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { GitPullStrategy } from '@shared/ipc'
import { branchNameProblem, namedGitBranch } from '@shared/utils/gitBranch'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Icon } from '@renderer/lib/icons'
import { ActionMenu, type ActionMenuItem } from '@renderer/lib/ui/ActionMenu'
import { Button } from '@renderer/lib/ui/Button'
import { cn } from '@renderer/lib/ui/cn'
import { CONTROL_HOVER } from '@renderer/lib/utils/layout'
import type { GitChrome } from './GitChrome'

const RUN_LOCK = 'Unlocks when the run stops'

/**
 * Where the branch stands against its upstream, and the sync actions, for a
 * pane's 40px row beside the branch picker: ↑ to push and ↓ to pull as muted
 * counts (only the sides that are not zero), a cloud when the branch has no
 * upstream yet. The menu fetches, pulls, pushes or publishes, and starts a new
 * branch in an inline field. Results land on the chrome's status line.
 *
 * `running`: a task is live in this checkout. Pull and New branch rewrite the
 * working tree under it, so they wait — the same lock Commit has.
 */
export function GitSyncControls({ chrome, running = false }: { chrome: GitChrome; running?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [diverged, setDiverged] = useState<{ detail: string; upstream: string } | null>(null)

  const status = chrome.result?.kind === 'ok' ? chrome.status : null
  if (!status) return null

  const branch = namedGitBranch(status.branch)
  const upstream = status.upstream ?? null
  const ahead = upstream ? (status.ahead ?? 0) : 0
  const behind = upstream ? (status.behind ?? 0) : 0
  const canPublish = Boolean(branch && status.hasRemote && !upstream && status.hasCommits)
  const syncing = chrome.syncing
  const locked = Boolean(syncing) || chrome.busy

  const pull = async (strategy?: GitPullStrategy): Promise<void> => {
    const result = await chrome.pull(strategy)
    if (result && result.kind === 'diverged') setDiverged({ detail: result.detail, upstream: result.upstream })
  }

  const noRemote = status.hasRemote ? undefined : 'No remote configured'
  const items: ActionMenuItem[] = [
    {
      id: 'fetch',
      label: 'Fetch',
      icon: 'refresh',
      detail: 'all remotes',
      disabled: locked || !status.hasRemote,
      ...(noRemote ? { disabledReason: noRemote } : {}),
      onSelect: () => void chrome.fetch()
    },
    {
      id: 'pull',
      label: 'Pull',
      icon: 'arrowDown',
      ...(upstream ? { detail: behind > 0 ? `${behind} from ${upstream}` : upstream } : {}),
      disabled: locked || running || !upstream,
      disabledReason: running ? RUN_LOCK : (noRemote ?? (upstream ? undefined : 'No upstream yet — publish first')),
      onSelect: () => void pull()
    },
    upstream
      ? {
          id: 'push',
          label: 'Push',
          icon: 'arrowUp',
          detail: ahead > 0 ? `${ahead} to ${upstream}` : upstream,
          disabled: locked,
          onSelect: () => void chrome.push()
        }
      : {
          id: 'publish',
          label: 'Publish branch',
          icon: 'cloud',
          ...(branch ? { detail: branch } : {}),
          disabled: locked || !canPublish,
          disabledReason:
            noRemote ?? (!branch ? 'HEAD is detached' : !status.hasCommits ? 'No commits yet' : undefined),
          onSelect: () => void chrome.push()
        },
    {
      id: 'branch',
      label: 'New branch…',
      icon: 'branch',
      separatorBefore: true,
      disabled: locked || running || !status.hasCommits,
      disabledReason: running ? RUN_LOCK : status.hasCommits ? undefined : 'No commits yet',
      onSelect: () => setNaming(true)
    }
  ]

  const summary = [
    upstream ? null : canPublish ? 'Not published' : null,
    ahead > 0 ? `${ahead} to push` : null,
    behind > 0 ? `${behind} to pull` : null,
    upstream && ahead === 0 && behind === 0 ? `Up to date with ${upstream}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      {naming ? (
        <NewBranchField
          busy={syncing === 'branch'}
          onCancel={() => setNaming(false)}
          onCreate={async (name) => {
            if (await chrome.createBranch(name)) setNaming(false)
          }}
        />
      ) : (
        <ActionMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          placement="down"
          align="start"
          aria-label="Sync"
          items={items}
          trigger={(t) => (
            <button
              ref={t.ref}
              type="button"
              className={cn(
                'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption tabular-nums text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring',
                CONTROL_HOVER
              )}
              aria-label={summary ? `Sync — ${summary}` : 'Sync'}
              aria-expanded={t['aria-expanded']}
              aria-controls={t['aria-controls']}
              aria-haspopup={t['aria-haspopup']}
              aria-busy={syncing ? true : undefined}
              title={menuOpen ? undefined : summary || undefined}
              onClick={t.onClick}
              data-git-sync
            >
              {syncing ? (
                <Icon name="loader" size={13} className="motion-safe:animate-spin" />
              ) : !upstream && canPublish ? (
                <Icon name="cloud" size={13} />
              ) : ahead === 0 && behind === 0 ? (
                <Icon name="refresh" size={13} />
              ) : null}
              {!syncing && ahead > 0 ? (
                <span className="inline-flex items-center gap-0.5" data-git-ahead>
                  <Icon name="arrowUp" size={12} />
                  {ahead}
                </span>
              ) : null}
              {!syncing && behind > 0 ? (
                <span className="inline-flex items-center gap-0.5" data-git-behind>
                  <Icon name="arrowDown" size={12} />
                  {behind}
                </span>
              ) : null}
            </button>
          )}
        />
      )}
      <Dialog
        open={diverged !== null}
        onClose={() => setDiverged(null)}
        title="Branch has diverged"
        description={diverged?.detail}
        className="vy-menu w-[min(92vw,28rem)] text-fg"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setDiverged(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setDiverged(null)
                void pull('merge')
              }}
            >
              Merge
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setDiverged(null)
                void pull('rebase')
              }}
            >
              Rebase
            </Button>
          </>
        }
      >
        <p className="m-0 text-sm text-secondary">
          Rebase replays your commits on top of {diverged?.upstream ?? 'the upstream'} and is undone if it stops on a
          conflict. Merge makes a merge commit and leaves any conflict for you to resolve.
        </p>
      </Dialog>
    </>
  )
}

/** The inline name field: Enter creates and switches, Escape puts the menu back. */
function NewBranchField({
  busy,
  onCreate,
  onCancel
}: {
  busy: boolean
  onCreate: (name: string) => void | Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const problemId = useId()
  // Quiet while empty: "Name the branch" is what the placeholder already says.
  const problem = name.trim() ? branchNameProblem(name) : null

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = (): void => {
    if (busy || !name.trim() || branchNameProblem(name)) return
    void onCreate(name.trim())
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }

  return (
    <form
      className="flex min-w-0 shrink items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      data-git-new-branch
    >
      <Icon name="branch" size={13} className="shrink-0 text-tertiary" />
      <input
        ref={inputRef}
        data-vy-text-entry
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (!name.trim() && !busy) onCancel()
        }}
        disabled={busy}
        placeholder="new-branch-name"
        aria-label="New branch name"
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? problemId : undefined}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          'h-6 w-40 min-w-0 rounded-md border bg-bg px-2 font-mono text-xs text-fg placeholder:text-tertiary vy-transition focus-visible:vy-focus-ring disabled:vy-disabled-state',
          problem ? 'border-danger' : 'border-border hover:border-border-strong'
        )}
      />
      {busy ? <Icon name="loader" size={13} className="shrink-0 text-muted motion-safe:animate-spin" /> : null}
      {problem ? (
        <span id={problemId} className="min-w-0 truncate text-caption text-danger" title={problem}>
          {problem}
        </span>
      ) : null}
    </form>
  )
}
