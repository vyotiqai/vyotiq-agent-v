import { useState } from 'react'
import { ActionMenu, Avatar, Button, IconButton, cn } from '@renderer/lib/ui'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { handleTabListKeyDown } from '@renderer/lib/utils/tabListKeyboard'
import { TEAMMATES_DETAIL_COLUMN } from '@renderer/lib/utils/layout'
import type { AgentProfile, AgentProfileDeleteResult, DelegatedTask } from '@shared/ipc'
import { TeammateTasks } from './TeammateTasks'
import { TeammateMemory } from './TeammateMemory'
import { TeammateSettings, useTeammateForm } from './TeammateSettings'
import { activeWorkSummary } from './taskPresentation'
import { isProfileUsableIn, unusableReason, workspaceLabel } from './teammatePresentation'

/**
 * One teammate, with what it is doing kept apart from what it is.
 *
 * Everything used to share a single scroll: the queue, five groups of form
 * fields, a danger zone, and a Save bar stuck to the bottom of that same
 * scroll — which is why it painted over the last row of whatever was beneath
 * it. Here the identity header never scrolls, Activity and Settings are two
 * panels, and the Save bar is a sibling below the scrollport rather than a
 * layer on top of it.
 */

export const TEAMMATE_TABS = ['activity', 'memory', 'settings'] as const
export type TeammateTab = (typeof TEAMMATE_TABS)[number]

const TAB_LABEL: Record<TeammateTab, string> = {
  activity: 'Activity',
  memory: 'Memory',
  settings: 'Settings'
}

export function TeammateDetail({
  profile,
  tasks,
  tab,
  onTabChange,
  secrets,
  ollamaBaseUrl,
  customOpenAiBaseUrl,
  openWorkspaces,
  activeWorkspacePath,
  onSave,
  onDelete,
  onStartChat,
  onAssignTask,
  onOpenRun,
  onRetryTask,
  onCancelTask
}: {
  profile: AgentProfile
  /** Every task belonging to this teammate, across open workspaces. */
  tasks: DelegatedTask[]
  tab: TeammateTab
  onTabChange: (tab: TeammateTab) => void
  secrets: Record<string, boolean>
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  openWorkspaces: string[]
  activeWorkspacePath: string | null
  onSave: (patch: Partial<AgentProfile>) => Promise<AgentProfile | null>
  onDelete: () => Promise<AgentProfileDeleteResult | null>
  onStartChat?: () => void
  onAssignTask: () => void
  onOpenRun?: (workspacePath: string, runId: string) => void
  onRetryTask: (task: DelegatedTask) => void
  onCancelTask: (task: DelegatedTask) => void
}) {
  const form = useTeammateForm(profile, onSave)
  const [menuOpen, setMenuOpen] = useState(false)
  const { confirm, dialog } = useConfirm()

  const blocked = unusableReason(profile, activeWorkspacePath)
  const work = activeWorkSummary(tasks)
  const canAssign = Boolean(activeWorkspacePath) && isProfileUsableIn(profile, activeWorkspacePath)
  const assignHint = !activeWorkspacePath
    ? 'Open a workspace to assign work.'
    : (blocked ?? `Assign a task to ${profile.name}`)

  const meta = [
    profile.scope === 'workspace'
      ? `Only in ${workspaceLabel(profile.workspacePath ?? null)}`
      : 'Available in every workspace',
    work.label,
    profile.model?.model ? `Pinned to ${profile.model.model}` : null
  ].filter(Boolean)

  const remove = async (): Promise<void> => {
    const ok = await confirm(
      `Delete ${profile.name}? Queued and running work stops. Its memory and past runs are kept.`,
      { title: `Delete ${profile.name}`, confirmLabel: 'Delete', danger: true }
    )
    if (!ok) return
    await onDelete()
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-teammate-detail={profile.id}
    >
      <header className="shrink-0 border-b border-border/40 px-5 pt-4">
        <div className={TEAMMATES_DETAIL_COLUMN}>
          <div className="flex flex-wrap items-start gap-3 pb-3">
            <Avatar
              name={profile.name}
              icon={profile.avatar}
              size="lg"
              tone={blocked ? 'muted' : 'accent'}
            />
            <div className="min-w-0 flex-1">
              <h2 className="m-0 truncate text-heading font-medium tracking-[var(--vy-tracking)] text-fg-strong">
                {profile.name}
              </h2>
              <p className="m-0 mt-0.5 truncate text-2xs text-muted" title={meta.join(' · ')}>
                {meta.join(' · ')}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {onStartChat ? (
                <Button
                  variant="subtle"
                  onClick={onStartChat}
                  disabled={Boolean(blocked)}
                  title={blocked ?? `Start a chat with ${profile.name}`}
                >
                  New chat
                </Button>
              ) : null}
              <Button
                variant="subtle"
                onClick={onAssignTask}
                disabled={!canAssign}
                title={assignHint}
              >
                Assign task
              </Button>
              <ActionMenu
                open={menuOpen}
                onOpenChange={setMenuOpen}
                placement="down"
                align="end"
                aria-label={`More actions for ${profile.name}`}
                items={[
                  {
                    id: 'delete',
                    label: 'Delete teammate',
                    icon: 'trash',
                    onSelect: () => void remove()
                  }
                ]}
                trigger={({ ref, onClick, ...aria }) => (
                  <IconButton
                    ref={ref}
                    onClick={onClick}
                    {...aria}
                    icon="more"
                    size="sm"
                    label={`More actions for ${profile.name}`}
                  />
                )}
              />
            </div>
          </div>

          <div
            className="-mb-px flex items-center gap-4"
            role="tablist"
            aria-label={`${profile.name} sections`}
            tabIndex={-1}
            onKeyDown={(e) =>
              handleTabListKeyDown(e, {
                tabs: [...TEAMMATE_TABS],
                activeId: tab,
                onSelect: (id) => onTabChange(id as TeammateTab)
              })
            }
          >
            {TEAMMATE_TABS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`teammate-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`teammate-panel-${id}`}
                // Explicit, because the count and the unsaved dot are inside
                // the button: without this the tab is announced as
                // "Activity 2" and "Settings Unsaved changes".
                aria-label={TAB_LABEL[id]}
                tabIndex={tab === id ? 0 : -1}
                className={cn(
                  'inline-flex items-center gap-1.5 border-b-2 pb-2 pt-1 text-sm tracking-[var(--vy-tracking)] vy-transition',
                  'focus-visible:vy-focus-ring',
                  tab === id
                    ? 'border-b-fg-strong text-fg-strong'
                    : 'border-b-transparent text-muted hover:text-fg'
                )}
                onClick={() => onTabChange(id)}
              >
                {TAB_LABEL[id]}
                {id === 'activity' && work.active ? (
                  <span className="tabular-nums text-2xs text-tertiary" aria-hidden>
                    {work.active}
                  </span>
                ) : null}
                {/* Unsaved work is invisible from the Activity tab otherwise,
                    and switching tabs would read as having lost it. The save
                    bar below carries the announcement. */}
                {id === 'settings' && form.dirty ? (
                  <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                ) : null}
              </button>
            ))}
          </div>
        </div>
      </header>

      {blocked ? (
        <p
          role="status"
          className="m-0 shrink-0 border-b border-border/40 bg-warning/10 px-5 py-2 text-xs text-warning"
        >
          {blocked}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div
          className={TEAMMATES_DETAIL_COLUMN}
          role="tabpanel"
          id={`teammate-panel-${tab}`}
          aria-labelledby={`teammate-tab-${tab}`}
        >
          {tab === 'activity' ? (
            <TeammateTasks
              profile={profile}
              tasks={tasks}
              canAssign={canAssign}
              assignHint={assignHint}
              openWorkspaces={openWorkspaces}
              onAssign={onAssignTask}
              onOpenRun={onOpenRun}
              onRetry={onRetryTask}
              onCancel={onCancelTask}
            />
          ) : tab === 'memory' ? (
            <TeammateMemory profile={profile} workspacePath={activeWorkspacePath} />
          ) : (
            <TeammateSettings
              profile={profile}
              form={form}
              secrets={secrets}
              ollamaBaseUrl={ollamaBaseUrl}
              customOpenAiBaseUrl={customOpenAiBaseUrl}
              openWorkspaces={openWorkspaces}
              activeWorkspacePath={activeWorkspacePath}
            />
          )}
        </div>
      </div>

      {/* Only while there is something to save. A permanently docked bar with
          two dead buttons is what made the old footer read as chrome — and it
          was inside the scroll, so it sat on top of the last row. */}
      {form.dirty ? (
        <div className="shrink-0 border-t border-border/40 bg-bg px-5 py-2.5 animate-fade-in">
          <div className={cn(TEAMMATES_DETAIL_COLUMN, 'flex items-center gap-2')}>
            <span className="mr-auto inline-flex items-center gap-1.5 text-2xs text-muted">
              <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
              Unsaved changes
            </span>
            <Button variant="ghost" onClick={form.reset}>
              Discard
            </Button>
            <Button
              onClick={() => void form.save()}
              disabled={!form.canSave}
              pending={form.saving}
              title={form.draft.name.trim() ? undefined : 'Give this teammate a name first.'}
            >
              Save changes
            </Button>
          </div>
        </div>
      ) : null}
      {dialog}
    </div>
  )
}
