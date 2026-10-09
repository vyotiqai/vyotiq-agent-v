import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitBranchEntry, GitStashEntry } from '@shared/ipc'
import { branchNameProblem } from '@shared/utils/gitBranch'
import { relativeTimeAgo } from '@shared/utils/timeFormat'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Icon } from '@renderer/lib/icons'
import { ActionMenu, Button, IconButton, Input, cn, type ActionMenuItem } from '@renderer/lib/ui'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { usePrompt } from '@renderer/lib/hooks/usePrompt'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'
import type { GitChrome } from './GitChrome'

/**
 * The repository's local branches: rename one, delete one, or merge one into
 * the branch you are on. Switching stays where it was (the branch picker).
 */
export function BranchesDialog({
  open,
  workspacePath,
  chrome,
  running,
  onClose
}: {
  open: boolean
  workspacePath: string
  chrome: GitChrome
  /** A task is live in this checkout: nothing that moves the tree runs. */
  running: boolean
  onClose: () => void
}) {
  const [branches, setBranches] = useState<GitBranchEntry[] | null>(null)
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renamingFrom = renaming?.from ?? null
  // Rename opens the name field with the caret in it.
  useEffect(() => {
    if (renamingFrom) renameInputRef.current?.focus()
  }, [renamingFrom])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { confirm, dialog } = useConfirm()

  const load = useCallback(async () => {
    const res = await window.vyotiq.gitBranches(workspacePath)
    if (res.ok) setBranches(res.data)
    else setError(res.error)
  }, [workspacePath])
  useEffect(() => {
    if (!open) return
    setRenaming(null)
    setError(null)
    void load()
  }, [open, load])

  const done = (detail: string, failed = false): void => {
    chrome.reportNotice(detail, failed)
    chrome.refresh()
    void load()
  }

  const remove = async (name: string, force = false): Promise<void> => {
    setBusy(true)
    const res = await window.vyotiq.gitBranchDelete({ workspacePath, branch: name, ...(force ? { force: true } : {}) })
    setBusy(false)
    if (!res.ok) return setError(res.error)
    if (res.data.unmerged) {
      const ok = await confirm(`${res.data.detail}. Delete ${name} anyway? Its commits are lost unless another branch or a tag has them.`, {
        title: 'Delete an unmerged branch?',
        confirmLabel: 'Delete anyway',
        danger: true
      })
      if (ok) await remove(name, true)
      return
    }
    done(res.data.detail)
  }

  const merge = async (name: string, current: string | null): Promise<void> => {
    const ok = await confirm(`Merge ${name} into ${current ?? 'the current branch'}? A conflict leaves markers to resolve in Changes.`, {
      title: 'Merge branch',
      confirmLabel: 'Merge'
    })
    if (!ok) return
    setBusy(true)
    const res = await window.vyotiq.gitIntegrate({ workspacePath, op: 'merge', target: name })
    setBusy(false)
    if (!res.ok) return setError(res.error)
    done(res.data.detail, res.data.conflicted)
    if (res.data.conflicted) onClose()
  }

  const rename = async (): Promise<void> => {
    if (!renaming) return
    const problem = branchNameProblem(renaming.to)
    if (problem) return setError(problem)
    setBusy(true)
    const res = await window.vyotiq.gitBranchRename({ workspacePath, from: renaming.from, to: renaming.to.trim() })
    setBusy(false)
    if (!res.ok) return setError(res.error)
    setRenaming(null)
    done(res.data.detail)
  }

  const current = branches?.find((b) => b.current)?.name ?? null
  const locked = busy || running
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Branches"
      icon="branch"
      className="vy-menu flex w-[min(34rem,calc(100vw_-_2rem))] flex-col overflow-hidden"
    >
      <div className="scroll-thin max-h-[60vh] overflow-y-auto px-4 py-2" data-git-branches>
        {running ? <p className="m-0 mb-2 text-xs text-muted">A task is working in this checkout; branches change when it stops.</p> : null}
        {error ? (
          <p role="alert" className="m-0 mb-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
        <ul className="m-0 list-none p-0">
          {(branches ?? []).map((b) => (
            <li key={b.name} className={cn('flex min-h-9 items-center gap-2 border-b py-1', BORDER_DIVIDER)} data-git-branch={b.name}>
              <Icon name={b.current ? 'check' : 'branch'} size={13} className={b.current ? 'shrink-0 text-accent' : 'shrink-0 text-tertiary'} />
              {renaming?.from === b.name ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void rename()
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <Input
                      size="sm"
                      ref={renameInputRef}
                      aria-label={`New name for ${b.name}`}
                      className="font-mono"
                      value={renaming.to}
                      onChange={(e) => setRenaming({ from: b.name, to: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          e.stopPropagation()
                          setRenaming(null)
                        }
                      }}
                    />
                  </div>
                  <Button size="xs" type="submit" disabled={locked}>
                    Rename
                  </Button>
                </form>
              ) : (
                <>
                  <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', b.current ? 'text-fg-strong' : 'text-fg')}>{b.name}</span>
                  <Button size="xs" variant="ghost" disabled={locked} onClick={() => setRenaming({ from: b.name, to: b.name })}>
                    Rename
                  </Button>
                  {!b.current ? (
                    <>
                      <Button size="xs" variant="ghost" disabled={locked || !current} onClick={() => void merge(b.name, current)}>
                        Merge in
                      </Button>
                      <Button size="xs" variant="ghost" disabled={locked} onClick={() => void remove(b.name)}>
                        Delete
                      </Button>
                    </>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
      {dialog}
    </Dialog>
  )
}

/**
 * Every stash in the repository, not only what a branch switch left: apply
 * one (and keep it), pop it, or drop it.
 */
export function StashesDialog({
  open,
  workspacePath,
  chrome,
  running,
  onClose
}: {
  open: boolean
  workspacePath: string
  chrome: GitChrome
  running: boolean
  onClose: () => void
}) {
  const [stashes, setStashes] = useState<GitStashEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { confirm, dialog } = useConfirm()

  const load = useCallback(async () => {
    const res = await window.vyotiq.gitStashList(workspacePath)
    if (res.ok) setStashes(res.data)
    else setError(res.error)
  }, [workspacePath])
  useEffect(() => {
    if (!open) return
    setError(null)
    void load()
  }, [open, load])

  const apply = async (s: GitStashEntry, drop: boolean): Promise<void> => {
    setBusy(true)
    const res = await window.vyotiq.gitStashApply({ workspacePath, sha: s.sha, ...(drop ? { drop: true } : {}) })
    setBusy(false)
    if (!res.ok) return setError(res.error)
    chrome.reportNotice(res.data.detail, res.data.conflicted)
    chrome.refresh()
    void load()
  }
  const drop = async (s: GitStashEntry): Promise<void> => {
    const ok = await confirm(`Drop “${s.message || s.ref}”? Its ${s.files} file${s.files === 1 ? '' : 's'} of changes are gone for good.`, {
      title: 'Drop stash?',
      confirmLabel: 'Drop',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    const res = await window.vyotiq.gitStashDropAny({ workspacePath, sha: s.sha })
    setBusy(false)
    if (!res.ok) return setError(res.error)
    void load()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Stashes"
      icon="archive"
      className="vy-menu flex w-[min(36rem,calc(100vw_-_2rem))] flex-col overflow-hidden"
    >
      <div className="scroll-thin max-h-[60vh] overflow-y-auto px-4 py-2" data-git-stashes>
        {error ? (
          <p role="alert" className="m-0 mb-2 text-xs text-danger">
            {error}
          </p>
        ) : null}
        {stashes && stashes.length === 0 ? <p className="m-0 py-4 text-xs text-tertiary">No stashes.</p> : null}
        <ul className="m-0 list-none p-0">
          {(stashes ?? []).map((s) => (
            <li key={s.sha} className={cn('flex items-center gap-2 border-b py-2', BORDER_DIVIDER)} data-git-stash={s.sha}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{s.message || s.ref}</span>
                <span className="block text-caption text-tertiary">
                  {s.branch ? `on ${s.branch} · ` : ''}
                  {s.files} file{s.files === 1 ? '' : 's'}
                  {s.createdAt ? ` · ${relativeTimeAgo(s.createdAt)}` : ''}
                </span>
              </span>
              <Button size="xs" variant="ghost" disabled={busy || running} onClick={() => void apply(s, false)}>
                Apply
              </Button>
              <Button size="xs" disabled={busy || running} onClick={() => void apply(s, true)}>
                Pop
              </Button>
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void drop(s)}>
                Drop
              </Button>
            </li>
          ))}
        </ul>
      </div>
      {dialog}
    </Dialog>
  )
}

/**
 * What can be done with one commit from the Commits list: revert it (a new
 * commit that undoes it), start a branch from it, or copy its id.
 */
export function CommitActionsMenu({
  workspacePath,
  commit,
  chrome,
  running
}: {
  workspacePath: string
  commit: { sha: string; shortSha: string; subject: string }
  chrome: GitChrome
  running: boolean
}) {
  const [open, setOpen] = useState(false)
  const { confirm, dialog: confirmDialog } = useConfirm()
  const { prompt, dialog: promptDialog } = usePrompt()
  const locked = running || chrome.busy

  const revert = async (): Promise<void> => {
    const ok = await confirm(
      `Make a new commit that undoes ${commit.shortSha} “${commit.subject}”? A conflict leaves markers to resolve in Changes.`,
      { title: 'Revert commit', confirmLabel: 'Revert' }
    )
    if (!ok) return
    const res = await window.vyotiq.gitIntegrate({ workspacePath, op: 'revert', target: commit.sha })
    if (!res.ok) chrome.reportNotice(res.error, true)
    else chrome.reportNotice(res.data.detail, res.data.conflicted)
    chrome.refresh()
  }

  const branchFromHere = async (): Promise<void> => {
    const name = await prompt(`New branch from ${commit.shortSha}`, '', { confirmLabel: 'Create and switch' })
    if (!name?.trim()) return
    const problem = branchNameProblem(name)
    if (problem) {
      chrome.reportNotice(problem, true)
      return
    }
    const res = await window.vyotiq.gitCreateBranch({ workspacePath, name: name.trim(), from: commit.sha })
    if (!res.ok) chrome.reportNotice(res.error, true)
    else chrome.reportNotice(res.data.detail)
    chrome.refresh()
  }

  const items: ActionMenuItem[] = [
    {
      id: 'revert',
      label: 'Revert this commit…',
      icon: 'undo',
      disabled: locked,
      ...(running ? { disabledReason: 'Unlocks when the run stops' } : {}),
      onSelect: () => void revert()
    },
    {
      id: 'branch-from',
      label: 'Branch from here…',
      icon: 'branch',
      disabled: locked,
      ...(running ? { disabledReason: 'Unlocks when the run stops' } : {}),
      onSelect: () => void branchFromHere()
    },
    {
      id: 'copy-sha',
      label: 'Copy commit id',
      icon: 'copy',
      onSelect: () => {
        window.vyotiq?.writeClipboard?.(commit.sha)
        chrome.reportNotice(`Copied ${commit.shortSha}`)
      }
    }
  ]

  return (
    <>
      <ActionMenu
        open={open}
        onOpenChange={setOpen}
        placement="down"
        align="end"
        aria-label="Commit actions"
        items={items}
        trigger={(t) => (
          <IconButton
            ref={t.ref}
            icon="more"
            label="Commit actions"
            size="xs"
            tone="muted"
            aria-expanded={t['aria-expanded']}
            aria-controls={t['aria-controls']}
            aria-haspopup={t['aria-haspopup']}
            onClick={t.onClick}
          />
        )}
      />
      {confirmDialog}
      {promptDialog}
    </>
  )
}
