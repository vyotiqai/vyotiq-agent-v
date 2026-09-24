import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react'
import type { ChatRewindPreviewResult } from '@shared/ipc'
import type { RevertWritesOutcome } from '@renderer/lib/hooks/createChatStreamController'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { Icon } from '@renderer/lib/icons'
import { Button, cn } from '@renderer/lib/ui'

export type RewindFile = ChatRewindPreviewResult['files'][number]

export type RewindAsk = {
  /** The run whose instruction the record rewinds to, as the record numbers it. */
  runN: number | null
  /** Null when main's preview could not be read — then no list is claimed. */
  files: RewindFile[] | null
}

/** What the task did to the file — the letter git would show. */
const MARK: Record<RewindFile['action'], { letter: string; title: string }> = {
  created: { letter: 'A', title: 'The task added it; rewinding removes it' },
  modified: { letter: 'M', title: 'The task changed it; rewinding puts it back' },
  deleted: { letter: 'D', title: 'The task deleted it; rewinding brings it back' }
}

/** A file the rewind leaves as it is, and why; null when it goes back. */
function keptBecause(file: RewindFile): string | null {
  if (file.edited) return 'changed since · left as is'
  if (!file.undoable) return 'no copy kept · left as is'
  return null
}

/** How many files the rewind will actually put back. */
export function rewindRestoreCount(files: readonly RewindFile[]): number {
  return files.filter((f) => keptBecause(f) == null).length
}

/**
 * The sentence under the title. A rewind keeps the instruction and removes
 * everything after it — this run's work and every later run — and it cannot
 * be taken back.
 */
/** What stays of a rewind: main keeps it until something would be overwritten by bringing it back. */
const REDO_NOTE = 'It’s kept, so you can redo it until you send a new instruction or change those files.'

export function rewindSummary(ask: RewindAsk): string {
  const from = ask.runN != null ? `run ${ask.runN}’s instruction` : 'this instruction'
  const record = `Everything after ${from} leaves the record`
  if (ask.files == null) {
    return `${record}, and the files the task changed after it go back to how they were. ${REDO_NOTE}`
  }
  const files = rewindRestoreCount(ask.files)
  if (files === 0) return `${record}, and no files change. ${REDO_NOTE}`
  return `${record}, and ${files === 1 ? 'this file goes' : 'these files go'} back to how ${files === 1 ? 'it was' : 'they were'} before it. ${REDO_NOTE}`
}

/**
 * The rewind confirmation: which run, what leaves the record, and each file the
 * task touched with what rewinding does to it. Files changed since the task
 * wrote them, or kept without a copy to restore from, are listed but left as
 * they are.
 */
export function RewindDialog({
  ask,
  onCancel,
  onConfirm
}: {
  ask: RewindAsk | null
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element | null {
  const titleId = useId()
  const descId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  if (!ask) return null
  const restore = ask.files ? rewindRestoreCount(ask.files) : 0
  const title = ask.runN != null ? `Rewind to before run ${ask.runN}?` : 'Rewind to before this instruction?'
  return (
    <Dialog
      open
      onClose={onCancel}
      labelledBy={titleId}
      describedBy={descId}
      useNativeDialog={false}
      padded={false}
      initialFocusRef={cancelRef}
      className="vy-menu flex w-[480px] flex-col overflow-hidden"
    >
      <div data-rewind-dialog className="flex min-h-0 flex-col">
        <div className="px-5 pb-2 pt-5">
          <div className="flex items-center gap-2">
            <Icon name="undo" size={18} className="text-muted" />
            <h2 id={titleId} className="text-heading font-semibold text-fg-strong">
              {title}
            </h2>
          </div>
          <p id={descId} className="mt-2 text-sm leading-[21px] text-secondary">
            {rewindSummary(ask)}
          </p>
        </div>
        {ask.files && ask.files.length > 0 ? (
          <ul
            aria-label="Files"
            className="my-3 max-h-[min(40vh,16rem)] min-h-0 divide-y divide-border overflow-y-auto border-y border-border"
          >
            {ask.files.map((file) => {
              const mark = MARK[file.action]
              const kept = keptBecause(file)
              return (
                <li key={file.path} className="flex h-8 items-center gap-2 px-5 text-xs">
                  <span className="w-3 shrink-0 font-mono font-semibold text-muted" title={mark.title}>
                    {mark.letter}
                  </span>
                  <FileTypeIcon path={file.path} size={13} />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate font-mono text-caption',
                      kept ? 'text-tertiary' : 'text-secondary'
                    )}
                    title={file.path}
                  >
                    {file.path}
                  </span>
                  {kept ? <span className="shrink-0 text-caption text-tertiary">{kept}</span> : null}
                </li>
              )
            })}
          </ul>
        ) : null}
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
          <span className="min-w-0 text-caption text-tertiary">Your own edits since then are left alone.</span>
          <span className="flex-1" />
          <Button ref={cancelRef} size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" icon="undo" onClick={onConfirm}>
            {restore > 0 ? `Rewind ${restore} ${restore === 1 ? 'file' : 'files'}` : 'Rewind'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** The line after a rewind: which run, then what happened to the files. */
export function rewoundToastText(runN: number | null, done: RevertWritesOutcome): string {
  const parts = [runN != null ? `Rewound to before run ${runN}` : 'Rewound to before the instruction']
  const count = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`
  if (done.restored.length > 0) parts.push(`${count(done.restored.length)} restored`)
  if (done.edited.length > 0) parts.push(`${count(done.edited.length)} left as you changed ${done.edited.length === 1 ? 'it' : 'them'}`)
  if (done.skipped.length > 0) parts.push(`${count(done.skipped.length)} not restored`)
  return parts.join(' · ')
}

/** Ask with the rewind dialog; resolves true on Rewind, false on Cancel or close. */
export function useRewindDialog(): {
  askRewind: (ask: RewindAsk) => Promise<boolean>
  dialog: JSX.Element | null
} {
  const [ask, setAsk] = useState<RewindAsk | null>(null)
  const resolverRef = useRef<((value: boolean) => void) | null>(null)

  const finish = useCallback((value: boolean): void => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setAsk(null)
    resolve?.(value)
  }, [])

  const askRewind = useCallback((next: RewindAsk): Promise<boolean> => {
    resolverRef.current?.(false)
    setAsk(next)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
    })
  }, [])

  useEffect(
    () => () => {
      resolverRef.current?.(false)
      resolverRef.current = null
    },
    []
  )

  return { askRewind, dialog: <RewindDialog ask={ask} onCancel={() => finish(false)} onConfirm={() => finish(true)} /> }
}
