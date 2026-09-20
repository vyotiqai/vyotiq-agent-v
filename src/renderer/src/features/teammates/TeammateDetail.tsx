import { useMemo, useState } from 'react'
import {
  Avatar,
  Badge,
  Button,
  FormGroup,
  FormRow,
  FormStack,
  Input,
  Menu,
  Switch,
  Textarea,
  Tooltip,
  cn,
  type MenuOption
} from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import type { AgentProfile, AgentProfileDeleteResult, DelegatedTask } from '@shared/ipc'
import { TeammateModelPin, type ModelPin } from './TeammateModelPin'
import { TeammateTasks } from './TeammateTasks'
import { TeammateOverrides } from './TeammateOverrides'
import { TEAMMATE_AVATARS, unusableReason, workspaceLabel } from './teammatePresentation'

/**
 * Everything one teammate is, in one editable place.
 *
 * Four of these fields — avatar, the model pin, autonomy and scope — are
 * honoured by the main process and had no editor anywhere in the app. The
 * others were previously only reachable through a cramped sidebar dialog.
 *
 * Edits are explicit: a draft is held locally and written on Save, so a push
 * from another surface cannot overwrite half-typed text, and abandoning an
 * edit changes nothing.
 */

type Draft = {
  name: string
  avatar: string | undefined
  persona: string
  identity: string
  tone: string
  model: ModelPin | undefined
  autonomousMode: 'inherit' | 'on' | 'off'
  autoResumeOnLaunch: boolean
  scope: 'global' | 'workspace'
  workspacePath: string | undefined
}

function draftOf(profile: AgentProfile): Draft {
  return {
    name: profile.name,
    avatar: profile.avatar,
    persona: profile.persona ?? '',
    identity: profile.identity ?? '',
    tone: profile.tone ?? '',
    model: profile.model,
    autonomousMode: profile.autonomousMode ?? 'inherit',
    autoResumeOnLaunch: profile.autoResumeOnLaunch ?? false,
    scope: profile.scope,
    workspacePath: profile.workspacePath
  }
}

const AUTONOMY_OPTIONS: MenuOption[] = [
  { value: 'inherit', label: 'Follow the app setting' },
  { value: 'on', label: 'Always autonomous' },
  { value: 'off', label: 'Always ask before tools' }
]

export function TeammateDetail({
  profile,
  tasks,
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
  const [draft, setDraft] = useState<Draft>(() => draftOf(profile))
  const [saving, setSaving] = useState(false)
  const { confirm, dialog } = useConfirm()

  const saved = useMemo(() => draftOf(profile), [profile])
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved]
  )
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((prev) => ({ ...prev, [key]: value }))

  const trimmedName = draft.name.trim()
  const scopeIncomplete = draft.scope === 'workspace' && !draft.workspacePath
  const canSave = Boolean(trimmedName) && !scopeIncomplete && dirty && !saving
  const blocked = unusableReason(profile, activeWorkspacePath)

  const save = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    try {
      // `undefined` clears a field: the store spreads the patch over the base,
      // so an omitted key keeps the old value while an explicit undefined
      // removes it. Clearing a textarea has to mean clearing the field.
      await onSave({
        name: trimmedName,
        avatar: draft.avatar || undefined,
        persona: draft.persona.trim() || undefined,
        identity: draft.identity.trim() || undefined,
        tone: draft.tone.trim() || undefined,
        model: draft.model,
        autonomousMode: draft.autonomousMode,
        autoResumeOnLaunch: draft.autoResumeOnLaunch,
        scope: draft.scope,
        workspacePath: draft.scope === 'workspace' ? draft.workspacePath : undefined
      })
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm(
      `Delete ${profile.name}? Queued and running work stops. Its memory and past runs are kept.`,
      { title: `Delete ${profile.name}`, confirmLabel: 'Delete', danger: true }
    )
    if (!ok) return
    await onDelete()
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-teammate-detail={profile.id}>
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={profile.name} icon={profile.avatar} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate text-heading font-medium tracking-[var(--vy-tracking)] text-fg-strong">
            {profile.name}
          </h2>
          <p className="m-0 mt-0.5 text-2xs text-muted">
            {profile.scope === 'workspace'
              ? `Only in ${workspaceLabel(profile.workspacePath ?? null)}`
              : 'Available in every workspace'}
          </p>
        </div>
        {onStartChat ? (
          <Tooltip content={blocked ?? `Start a chat with ${profile.name}`}>
            <span className={blocked ? 'inline-flex cursor-not-allowed' : 'inline-flex'}>
              <Button
                variant="subtle"
                onClick={onStartChat}
                disabled={Boolean(blocked)}
                title={blocked ?? undefined}
              >
                New chat
              </Button>
            </span>
          </Tooltip>
        ) : null}
      </div>

      {blocked ? (
        <p role="status" className="m-0 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          {blocked}
        </p>
      ) : null}

      <TeammateTasks
        profile={profile}
        tasks={tasks}
        activeWorkspacePath={activeWorkspacePath}
        onAssign={onAssignTask}
        onOpenRun={onOpenRun}
        onRetry={onRetryTask}
        onCancel={onCancelTask}
      />

      <FormStack>
        <FormGroup title="Identity">
          <FormRow id="teammate-name" title="Name">
            <Input
              value={draft.name}
              aria-label="Name"
              onChange={(e) => set('name', e.target.value)}
            />
          </FormRow>
          <FormRow
            id="teammate-avatar"
            title="Avatar"
            hint="Shown wherever this teammate appears."
            wide
          >
            <div className="flex flex-wrap gap-1" role="group" aria-label="Avatar">
              <button
                type="button"
                aria-label="No avatar"
                aria-pressed={!draft.avatar}
                className={cn(
                  'grid size-8 place-items-center rounded-md border vy-transition focus-visible:vy-focus-ring',
                  !draft.avatar
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-muted hover:bg-surface-2'
                )}
                onClick={() => set('avatar', undefined)}
              >
                {(trimmedName.slice(0, 1) || '?').toUpperCase()}
              </button>
              {TEAMMATE_AVATARS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  aria-label={icon}
                  aria-pressed={draft.avatar === icon}
                  className={cn(
                    'grid size-8 place-items-center rounded-md border vy-transition focus-visible:vy-focus-ring',
                    draft.avatar === icon
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-muted hover:bg-surface-2'
                  )}
                  onClick={() => set('avatar', icon)}
                >
                  <Icon name={icon} size={16} />
                </button>
              ))}
            </div>
          </FormRow>
          <FormRow
            id="teammate-persona"
            title="Persona"
            hint="What this teammate is."
            wide
          >
            <Textarea
              value={draft.persona}
              aria-label="Persona"
              rows={3}
              placeholder="A terse senior frontend engineer who never touches backend files."
              className="rounded-md border border-border bg-surface px-2 py-1.5"
              onChange={(e) => set('persona', e.target.value)}
            />
          </FormRow>
          <FormRow
            id="teammate-identity"
            title="Identity"
            hint="Long-term context it should carry into every run."
            wide
          >
            <Textarea
              value={draft.identity}
              aria-label="Identity"
              rows={3}
              placeholder="Owns the design system. Prefers pnpm. Runs vitest before claiming done."
              className="rounded-md border border-border bg-surface px-2 py-1.5"
              onChange={(e) => set('identity', e.target.value)}
            />
          </FormRow>
          <FormRow id="teammate-tone" title="Tone" hint="How it responds.">
            <Input
              value={draft.tone}
              aria-label="Tone"
              placeholder="Direct, no filler, code first."
              onChange={(e) => set('tone', e.target.value)}
            />
          </FormRow>
        </FormGroup>

        <FormGroup title="Model and behaviour">
          <FormRow
            id="teammate-model"
            title="Pinned model"
            hint="Every run bound to this teammate starts on this model. A model you pick by hand still wins for that run."
            wide
          >
            <TeammateModelPin
              value={draft.model}
              onChange={(next) => set('model', next)}
              secrets={secrets}
              ollamaBaseUrl={ollamaBaseUrl}
              customOpenAiBaseUrl={customOpenAiBaseUrl}
            />
          </FormRow>
          <FormRow
            id="teammate-autonomy"
            title="Tool approvals"
            hint="Whether this teammate asks before running tools."
          >
            <Menu
              value={draft.autonomousMode}
              options={AUTONOMY_OPTIONS}
              aria-label="Tool approvals"
              placement="down"
              onChange={(next) => set('autonomousMode', next as Draft['autonomousMode'])}
            />
          </FormRow>
          <FormRow
            id="teammate-auto-resume"
            title="Auto-resume at launch"
            hint="Relaunch this teammate's interrupted runs when the app starts."
          >
            <Switch
              checked={draft.autoResumeOnLaunch}
              onCheckedChange={(next) => set('autoResumeOnLaunch', next)}
              label="Auto-resume interrupted runs at app launch"
              size="md"
            />
          </FormRow>
        </FormGroup>

        <FormGroup title="Availability">
          <FormRow
            id="teammate-scope"
            title="Scope"
            hint="A workspace teammate stays out of every other project's roster."
            wide
          >
            <div className="flex w-full flex-col items-stretch gap-2">
              <Menu
                value={draft.scope}
                options={[
                  { value: 'global', label: 'Every workspace' },
                  { value: 'workspace', label: 'One workspace only' }
                ]}
                aria-label="Scope"
                placement="down"
                onChange={(next) => {
                  const scope = next as Draft['scope']
                  setDraft((prev) => ({
                    ...prev,
                    scope,
                    workspacePath:
                      scope === 'workspace'
                        ? (prev.workspacePath ?? activeWorkspacePath ?? openWorkspaces[0])
                        : undefined
                  }))
                }}
              />
              {draft.scope === 'workspace' ? (
                <>
                  <Menu
                    value={draft.workspacePath ?? ''}
                    options={openWorkspaces.map((path) => ({
                      value: path,
                      label: workspaceLabel(path)
                    }))}
                    aria-label="Workspace"
                    placement="down"
                    onChange={(next) => set('workspacePath', next)}
                  />
                  {/* Narrowing strands work elsewhere: main refuses to resolve
                      the profile outside its workspace, so a task already
                      queued in another project fails when it starts. */}
                  <p className="m-0 text-2xs text-warning">
                    Chats and queued tasks for this teammate in other workspaces will stop
                    working.
                  </p>
                </>
              ) : null}
              {scopeIncomplete ? (
                <p className="m-0 text-2xs text-danger" role="alert">
                  Choose a workspace.
                </p>
              ) : null}
            </div>
          </FormRow>
        </FormGroup>

        <TeammateOverrides
          profile={profile}
          openWorkspaces={openWorkspaces}
          secrets={secrets}
          ollamaBaseUrl={ollamaBaseUrl}
          customOpenAiBaseUrl={customOpenAiBaseUrl}
        />

        <FormGroup title="Danger zone">
          <FormRow
            id="teammate-delete"
            title="Delete this teammate"
            hint="Stops its queued and running work. Its memory and past runs are kept."
          >
            <Button variant="danger" onClick={() => void remove()}>
              Delete
            </Button>
          </FormRow>
        </FormGroup>
      </FormStack>

      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-border/30 bg-bg py-3">
        {dirty ? (
          <Badge tone="warning" className="mr-auto">
            Unsaved changes
          </Badge>
        ) : null}
        <Button variant="ghost" onClick={() => setDraft(draftOf(profile))} disabled={!dirty}>
          Discard
        </Button>
        <Button onClick={() => void save()} disabled={!canSave} pending={saving}>
          Save changes
        </Button>
      </div>
      {dialog}
    </div>
  )
}
