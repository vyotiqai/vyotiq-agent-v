import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, EmptyState, IconButton, Input, PageHeader, cn, pushToast } from '@renderer/lib/ui'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'
import { CHAT_GUTTER } from '@renderer/lib/utils/layout'
import { useAgentProfiles } from '@renderer/lib/hooks/useAgentProfiles'
import { useDelegatedTasks } from '@renderer/lib/hooks/useDelegatedTasks'
import type { AgentProfile, DelegatedTask } from '@shared/ipc'
import { TeammateRail } from './TeammateRail'
import { TeammateDetail, type TeammateTab } from './TeammateDetail'
import { TaskInbox } from './TaskInbox'
import { AssignTaskDialog } from './AssignTaskDialog'

/**
 * The Teammates pane.
 *
 * Teammates used to live at the bottom of the sidebar's chat list, below every
 * workspace and every chat, inside the branch that only renders when a
 * workspace is open — and the sidebar replaces that whole scroll area when it
 * is collapsed or in Home mode, so the roster simply vanished. It is a
 * destination now, like Settings and Marketplace, which is also the only way
 * there is room for identity, a model pin, autonomy, scope and history.
 *
 * Shape: a rail that owns navigation, and one pane beside it. The page header
 * used to sit in the window gutter while the body was centred in a 1040px
 * column, so on a wide display the title and the content it titled were three
 * hundred pixels apart with nothing between them.
 */

/** What the pane beside the rail is showing. */
type View = 'roster' | 'inbox'

export function TeammatesView({
  secrets,
  ollamaBaseUrl,
  customOpenAiBaseUrl,
  openWorkspaces,
  activeWorkspacePath,
  onClose,
  onStartTeammateChat,
  onOpenTaskRun
}: {
  secrets: Record<string, boolean>
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  openWorkspaces: string[]
  activeWorkspacePath: string | null
  onClose: () => void
  onStartTeammateChat?: (profileId: string) => void
  onOpenTaskRun?: (workspacePath: string, runId: string) => void
}) {
  const { profiles, ready, error, createProfile, updateProfile, deleteProfile, clearError } =
    useAgentProfiles()
  const {
    tasks,
    ready: tasksReady,
    error: tasksError,
    enqueueTask,
    cancelTask,
    retryTask,
    clearError: clearTasksError
  } = useDelegatedTasks()

  const [view, setView] = useState<View>('roster')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [assignTo, setAssignTo] = useState<AgentProfile | null>(null)
  // Null until the user picks one, so the default can follow what the teammate
  // actually has (see `detailTab`) without overriding a deliberate choice, and
  // so switching teammates keeps you on the tab you were reading.
  const [pickedTab, setPickedTab] = useState<TeammateTab | null>(null)
  const newNameRef = useRef<HTMLInputElement>(null)

  useEscapeToClose(onClose, true, { deferToMenus: true })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return profiles
    return profiles.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.persona ?? '').toLowerCase().includes(q) ||
        (p.identity ?? '').toLowerCase().includes(q)
    )
  }, [profiles, query])

  // Keep a valid selection as the roster changes underneath — a delete here,
  // or a push from the composer picker creating one elsewhere.
  useEffect(() => {
    if (selectedId && profiles.some((p) => p.id === selectedId)) return
    setSelectedId(profiles[0]?.id ?? null)
  }, [profiles, selectedId])

  const selected = profiles.find((p) => p.id === selectedId) ?? null
  const selectedTasks = useMemo(
    () => (selected ? tasks.filter((t) => t.profileId === selected.id) : []),
    [tasks, selected]
  )

  // Show the side that has something on it: a teammate with a queue opens on
  // its work, a fresh one opens in the editor there is nothing else to see.
  const detailTab: TeammateTab = pickedTab ?? (selectedTasks.length > 0 ? 'activity' : 'settings')

  const nameFor = (profileId: string): string =>
    profiles.find((p) => p.id === profileId)?.name ?? 'this teammate'

  const retry = async (task: DelegatedTask): Promise<void> => {
    const result = await retryTask(task.id)
    if (result.ok) pushToast(`Task reassigned to ${nameFor(task.profileId)}`)
    else pushToast(`Could not retry task — ${result.error}`, 'error')
  }

  // The store surfaces a refused stop as its own error, so the click never
  // silently does nothing; nothing extra to report here on failure.
  const cancel = async (task: DelegatedTask): Promise<void> => {
    await cancelTask(task.id)
  }

  const openCreate = (): void => {
    setNewName('')
    setCreating(true)
  }

  const create = async (): Promise<void> => {
    const name = newName.trim()
    if (!name || saving) return
    setSaving(true)
    try {
      const created = await createProfile({ name, scope: 'global' })
      if (!created) {
        pushToast('Could not create teammate', 'error')
        return
      }
      // Land in the full editor rather than the roster: the dialog asks only
      // for a name, and everything that makes a teammate useful is in here.
      setView('roster')
      setPickedTab('settings')
      setSelectedId(created.id)
      setCreating(false)
      setNewName('')
      setQuery('')
      pushToast(`Teammate "${created.name}" created`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg pt-9 animate-fade-in"
      data-teammates-shell
    >
      <PageHeader
        bordered={false}
        className={cn('shrink-0 border-b border-border/30 bg-bg py-3', CHAT_GUTTER)}
        title="Teammates"
        description="Persistent agents with their own memory, model and queue."
        trailing={
          <IconButton
            icon="close"
            label="Close teammates"
            variant="ghost"
            size="sm"
            onClick={onClose}
          />
        }
      />

      {error || tasksError ? (
        <div className={cn('flex shrink-0 flex-col gap-2 pt-3', CHAT_GUTTER)}>
          {error ? (
            <Alert variant="danger" onDismiss={clearError} dismissLabel="Dismiss teammate warning">
              {error}
            </Alert>
          ) : null}
          {tasksError ? (
            <Alert variant="danger" onDismiss={clearTasksError} dismissLabel="Dismiss task warning">
              {tasksError}
            </Alert>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <TeammateRail
          profiles={filtered}
          tasks={tasks}
          ready={ready}
          selectedId={selectedId}
          rosterActive={view === 'roster'}
          inboxActive={view === 'inbox'}
          query={query}
          onQuery={setQuery}
          onSelect={(id) => {
            setSelectedId(id)
            setView('roster')
          }}
          onOpenInbox={() => setView('inbox')}
          onCreate={openCreate}
          activeWorkspacePath={activeWorkspacePath}
        />

        {view === 'inbox' ? (
          <TaskInbox
            tasks={tasks}
            profiles={profiles}
            ready={tasksReady}
            openWorkspaces={openWorkspaces}
            onOpenRun={onOpenTaskRun}
            onRetry={(task) => void retry(task)}
            onCancel={(task) => void cancel(task)}
          />
        ) : selected ? (
          <TeammateDetail
            key={selected.id}
            profile={selected}
            tasks={selectedTasks}
            tab={detailTab}
            onTabChange={setPickedTab}
            secrets={secrets}
            ollamaBaseUrl={ollamaBaseUrl}
            customOpenAiBaseUrl={customOpenAiBaseUrl}
            openWorkspaces={openWorkspaces}
            activeWorkspacePath={activeWorkspacePath}
            onAssignTask={() => setAssignTo(selected)}
            onOpenRun={onOpenTaskRun}
            onRetryTask={(task) => void retry(task)}
            onCancelTask={(task) => void cancel(task)}
            onSave={async (patch) => {
              const updated = await updateProfile({ id: selected.id, patch })
              pushToast(
                updated ? `Teammate "${updated.name}" updated` : 'Could not update teammate',
                updated ? 'info' : 'error'
              )
              return updated
            }}
            onDelete={async () => {
              const result = await deleteProfile(selected.id)
              if (!result) {
                pushToast('Could not delete teammate', 'error')
                return null
              }
              // The counts were computed, sent over IPC, and thrown away by
              // every caller. Deleting a teammate that was mid-task should say
              // what it stopped.
              const stopped = [
                result.cancelledTasks
                  ? `${result.cancelledTasks} task${result.cancelledTasks === 1 ? '' : 's'}`
                  : null,
                result.cancelledRuns
                  ? `${result.cancelledRuns} run${result.cancelledRuns === 1 ? '' : 's'}`
                  : null
              ].filter(Boolean)
              pushToast(
                stopped.length
                  ? `Deleted ${selected.name} — stopped ${stopped.join(' and ')}`
                  : `Deleted ${selected.name}`
              )
              return result
            }}
            onStartChat={onStartTeammateChat ? () => onStartTeammateChat(selected.id) : undefined}
          />
        ) : (
          // Only reachable with an empty roster: `selected` is found in the
          // unfiltered list, so searching narrows the rail without blanking
          // the teammate you were looking at.
          <div className="grid min-h-0 min-w-0 flex-1 place-items-center px-5">
            <EmptyState
              icon="bot"
              title={ready ? 'No teammates yet' : 'Loading teammates…'}
              description={
                ready
                  ? 'A teammate keeps its own memory per project, can pin a model, and takes tasks you hand it.'
                  : undefined
              }
              action={
                ready ? <Button onClick={openCreate}>Create your first teammate</Button> : undefined
              }
            />
          </div>
        )}
      </div>

      <AssignTaskDialog
        profile={assignTo}
        workspacePath={activeWorkspacePath}
        onClose={() => setAssignTo(null)}
        onAssign={enqueueTask}
      />

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New teammate"
        initialFocusRef={newNameRef}
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Name
            <Input
              ref={newNameRef}
              value={newName}
              placeholder="Frontend Fixer"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create()
              }}
            />
          </label>
          <p className="m-0 text-2xs text-muted">
            Persona, model and availability come next, in the editor.
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="subtle" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={!newName.trim() || saving}>
              Create teammate
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
