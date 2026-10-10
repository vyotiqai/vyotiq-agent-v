import { useMemo } from 'react'
import { parseViewSpec } from '@shared/viewSpec'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton } from '@renderer/lib/ui'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { RunSessionProvider, type RunSessionValue } from '@renderer/features/chat/RunSessionContext'
import type { WorkspaceFileOpenOptions } from '@renderer/features/chat/components/FilesPanel'
import { ViewCard } from '@renderer/features/task/record/reply/view/ViewFence'
import { unpinScreen, usePinnedScreens, type PinnedScreen } from './screensStore'

/*
  A view pinned to Home from a task's answer, opened on a page of its own.
  It draws the layout the agent wrote and reads every figure fresh: no model
  call, and nothing on it is older than the moment it opened. A new question
  goes to the composer, like any other.
*/

export type ScreenRequest = {
  pinned: PinnedScreen
  /** A new open, even of the same view. */
  nonce: number
}

export function ScreenPage({
  request,
  onClose,
  onOpenTask,
  onOpenWorkspaceFile
}: {
  request: ScreenRequest
  onClose: () => void
  /** Back to the task whose answer it came from. */
  onOpenTask: (workspacePath: string, runId: string) => void
  /** A changed file's row asks for its diff (`mode: 'diff'`). */
  onOpenWorkspaceFile: (workspacePath: string, path: string, options?: WorkspaceFileOpenOptions) => void
}) {
  const { pinned } = request
  const { workspacePath, runId } = pinned
  const spec = useMemo(() => parseViewSpec(pinned.spec), [pinned.spec])
  // Its newest copy: renamed on Home, or pinned again on a newer layout, while this page is open.
  const current = usePinnedScreens().find((p) => p.id === pinned.id) ?? null
  const stillPinned = current != null
  const title = current?.title ?? pinned.title

  const session = useMemo<RunSessionValue>(
    () => ({ workspacePath, runId: null, onOpenWorkspaceFile: (path: string, options?: WorkspaceFileOpenOptions) => onOpenWorkspaceFile(workspacePath, path, options) }),
    [workspacePath, onOpenWorkspaceFile]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-screen>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <Icon name="grid" size={14} className="shrink-0 text-tertiary" />
        <h1 className="min-w-0 truncate text-sm font-medium text-fg-strong">{title}</h1>
        <span className="min-w-0 shrink truncate text-xs text-tertiary">{formatWorkspaceName(workspacePath)}</span>
        <span className="flex-1" />
        {runId ? (
          <Button size="xs" variant="ghost" icon="arrowRight" onClick={() => onOpenTask(workspacePath, runId)}>
            Open task
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          icon="pin"
          aria-pressed={stillPinned}
          disabled={!stillPinned}
          onClick={() => {
            unpinScreen(pinned.id)
            onClose()
          }}
        >
          Unpin
        </Button>
        {/* Named for what it closes: the window's own Close sits in the same tab order. */}
        <IconButton size="xs" icon="close" label="Close view" onClick={onClose} />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto w-full max-w-[880px] px-8 pb-12 pt-6" data-screen-state={spec ? 'ready' : 'failed'}>
          {spec ? (
            <RunSessionProvider value={session}>
              <ViewCard spec={spec} streaming={false} chrome={false} />
              <p className="m-0 mt-8 text-caption text-tertiary">Pinned from a task · every value is read live</p>
            </RunSessionProvider>
          ) : (
            <p className="m-0 flex items-start gap-2 text-sm text-fg" role="alert">
              <Icon name="warningCircle" size={14} className="mt-[3px] shrink-0 text-danger" />
              This pinned view could not be read. Unpin it and ask again in the composer.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
