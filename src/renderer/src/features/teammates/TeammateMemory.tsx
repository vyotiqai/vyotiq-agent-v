import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  IconButton,
  MarkdownContent,
  Textarea,
  cn,
  pushToast
} from '@renderer/lib/ui'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { useTeammateMemory } from '@renderer/lib/hooks/useTeammateMemory'
import type { AgentProfile } from '@shared/ipc'
import { workspaceLabel } from './teammatePresentation'

/**
 * What a teammate remembers, in the one place it was never visible.
 *
 * `.vyotiq/agents/<id>/memory/` is the private namespace the whole feature is
 * sold on, and nothing in the app could read it. Deleting a teammate
 * deliberately *preserves* this directory, so the app was keeping something it
 * would not show you. The agent's own file tools skip `.vyotiq` when they
 * search, so even asking a chat to read it back was unreliable.
 *
 * Layout is fixed by the memory tools: `index.md` is injected into the system
 * prompt every step, `state.md` is scratch the teammate keeps between runs, and
 * `notes/*.md` are the durable notes `index.md` points at.
 */

const INDEX = 'index.md'
const STATE = 'state.md'

/** The two fixed files, then the notes. Matches the order the tools describe. */
function filesOf(notes: readonly string[], hasState: boolean): string[] {
  return [INDEX, ...(hasState ? [STATE] : []), ...notes.map((n) => `notes/${n}`)]
}

function describe(path: string): string {
  if (path === INDEX) return 'Injected into every step of every run. Keep it short.'
  if (path === STATE) return 'Scratch the teammate keeps between runs.'
  return 'A durable note. Reachable only if index.md points at it.'
}

export function TeammateMemory({
  profile,
  workspacePath
}: {
  profile: AgentProfile
  /** The namespace is per project, so the panel follows the active workspace. */
  workspacePath: string | null
}) {
  const {
    byKey,
    filesByKey,
    keyFor,
    ensureLoaded,
    reload,
    readFile,
    writeFile,
    clearMemory,
    error,
    clearError
  } = useTeammateMemory()
  const [selected, setSelected] = useState<string>(INDEX)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { confirm, dialog } = useConfirm()

  const key = workspacePath ? keyFor(workspacePath, profile.id) : null
  const listing = key ? byKey[key] : undefined
  const files = useMemo(
    () => (listing?.exists ? filesOf(listing.notes, listing.hasState) : []),
    [listing]
  )
  const contents = key ? filesByKey[key]?.[selected] : undefined

  useEffect(() => {
    if (workspacePath) ensureLoaded(workspacePath, profile.id)
  }, [workspacePath, profile.id, ensureLoaded])

  // Selection has to survive a listing that no longer holds it — a clear, or a
  // note the teammate removed between visits.
  useEffect(() => {
    if (files.length === 0 || files.includes(selected)) return
    setSelected(files[0] ?? INDEX)
  }, [files, selected])

  // Fetch whatever is selected. Dropping the draft here is deliberate: the
  // store discards cached contents after any write, so a stale draft would
  // silently overwrite what the teammate wrote in the meantime.
  useEffect(() => {
    setDraft(null)
    if (!workspacePath || !listing?.exists) return
    if (contents !== undefined) return
    void readFile(workspacePath, profile.id, selected)
  }, [workspacePath, profile.id, selected, listing?.exists, contents, readFile])

  if (!workspacePath) {
    return (
      <EmptyState
        icon="memory"
        title="Open a project to see this memory"
        description={`${profile.name} keeps a separate memory in every project, so there is nothing to show until one is open.`}
      />
    )
  }

  if (listing && !listing.exists) {
    return (
      <EmptyState
        icon="memory"
        title="Nothing remembered yet"
        description={`${profile.name} has not written anything in ${workspaceLabel(workspacePath)}. Memory appears here once it runs and records something worth keeping.`}
        // The empty state is exactly when a refresh matters most: this panel
        // has no push channel, so a run writing its first note while you are
        // looking at this screen would otherwise leave it saying "nothing"
        // until the pane is remounted.
        action={
          <Button
            variant="subtle"
            data-testid="teammate-memory-refresh"
            onClick={() => reload(workspacePath, profile.id)}
          >
            Check again
          </Button>
        }
      />
    )
  }

  if (!listing) {
    // A failed list has no listing to render, and without this the panel sat on
    // "Loading memory…" forever with the reason held in the store, unread.
    return error ? (
      <Alert variant="danger" onDismiss={clearError} dismissLabel="Dismiss memory warning">
        {error}
      </Alert>
    ) : (
      <EmptyState icon="memory" title="Loading memory…" />
    )
  }

  const unindexed = listing.notes.filter((n) => !listing.indexedNotes.includes(n))
  const dirty = draft !== null && draft !== contents

  const save = async (): Promise<void> => {
    if (draft === null || busy) return
    setBusy(true)
    try {
      const ok = await writeFile(workspacePath, profile.id, selected, draft)
      if (ok) {
        pushToast(`Saved ${selected}`)
        setDraft(null)
      }
    } finally {
      setBusy(false)
    }
  }

  const wipe = async (): Promise<void> => {
    const ok = await confirm(
      `Delete everything ${profile.name} remembers in ${workspaceLabel(workspacePath)}? Its notes, index and state are removed. Past runs and the teammate itself are kept.`,
      { title: `Clear ${profile.name}'s memory`, confirmLabel: 'Clear memory', danger: true }
    )
    if (!ok) return
    setBusy(true)
    try {
      if (await clearMemory(workspacePath, profile.id)) {
        pushToast(`Cleared ${profile.name}'s memory in ${workspaceLabel(workspacePath)}`)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-teammate-memory={profile.id}>
      {error ? (
        <Alert variant="danger" onDismiss={clearError} dismissLabel="Dismiss memory warning">
          {error}
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 mr-auto text-2xs text-muted">
          Private to {profile.name} in {workspaceLabel(workspacePath)}. Kept when the teammate is
          deleted.
        </p>
        {unindexed.length ? (
          // The index is the map the teammate retrieves through, so a note it
          // does not point at is on disk but invisible to the run.
          <Badge tone="warning">
            {unindexed.length} note{unindexed.length === 1 ? '' : 's'} not in index.md
          </Badge>
        ) : null}
        {/* The store has no push channel on purpose, and it caches per key, so a
            run that writes memory while this panel is open is otherwise invisible
            until the pane is remounted. This is the only way back to disk. */}
        <IconButton
          icon="refresh"
          size="xs"
          label={`Refresh ${profile.name}'s memory`}
          title="Re-read this memory from disk"
          data-testid="teammate-memory-refresh"
          disabled={busy}
          onClick={() => reload(workspacePath, profile.id)}
        />
        <Button variant="danger" onClick={() => void wipe()} disabled={busy}>
          Clear memory
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {files.map((path) => (
          <button
            key={path}
            type="button"
            aria-pressed={selected === path}
            title={describe(path)}
            className={cn(
              'rounded-md px-2 py-1 text-2xs vy-transition focus-visible:vy-focus-ring',
              selected === path
                ? 'bg-surface text-fg-strong'
                : 'text-muted hover:bg-surface/60 hover:text-fg'
            )}
            onClick={() => setSelected(path)}
          >
            {path}
          </button>
        ))}
      </div>

      <p className="m-0 text-2xs text-tertiary">{describe(selected)}</p>

      {draft === null ? (
        <div className="rounded-xl bg-surface p-3">
          {contents === undefined ? (
            <p className="m-0 text-2xs text-muted">Loading {selected}…</p>
          ) : contents.trim() ? (
            <MarkdownContent content={contents} />
          ) : (
            <p className="m-0 text-2xs text-muted">{selected} is empty.</p>
          )}
        </div>
      ) : (
        <div
          className={cn(
            'rounded-md border border-border bg-surface px-2.5 py-1 vy-transition',
            'focus-within:border-border-strong focus-within:vy-focus-ring'
          )}
        >
          <Textarea
            value={draft}
            rows={14}
            aria-label={`${selected} contents`}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        {draft === null ? (
          <Button
            variant="subtle"
            disabled={contents === undefined}
            onClick={() => setDraft(contents ?? '')}
          >
            Edit {selected}
          </Button>
        ) : (
          <>
            <Button onClick={() => void save()} disabled={!dirty || busy} pending={busy}>
              Save {selected}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Discard
            </Button>
          </>
        )}
      </div>
      {dialog}
    </div>
  )
}
