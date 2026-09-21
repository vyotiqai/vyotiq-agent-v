import { useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import {
  FormGroup,
  FormRow,
  FormStack,
  Input,
  Menu,
  Switch,
  Textarea,
  cn,
  type MenuOption
} from '@renderer/lib/ui'
import type { AgentProfile } from '@shared/ipc'
import { TeammateModelPin, usablePin, type ModelPin } from './TeammateModelPin'
import { TeammateOverrides } from './TeammateOverrides'
import { TeammateAvatarPicker } from './TeammateAvatarPicker'
import { workspaceLabel } from './teammatePresentation'

/**
 * Everything one teammate *is*, separated from everything it is *doing*.
 *
 * Four of these fields — avatar, the model pin, autonomy and scope — are
 * honoured by the main process and had no editor anywhere in the app.
 *
 * Edits are explicit: a draft is held locally and written on Save, so a push
 * from another surface cannot overwrite half-typed text, and abandoning an
 * edit changes nothing.
 */

export type TeammateDraft = {
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

export type TeammateForm = {
  draft: TeammateDraft
  set: <K extends keyof TeammateDraft>(key: K, value: TeammateDraft[K]) => void
  setDraft: Dispatch<SetStateAction<TeammateDraft>>
  dirty: boolean
  canSave: boolean
  saving: boolean
  reset: () => void
  save: () => Promise<void>
}

function draftOf(profile: AgentProfile): TeammateDraft {
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

/**
 * The draft lives a level above the form so the detail pane can show that
 * there is unsaved work while the Activity tab is open — switching tabs must
 * not look like a place edits go to die.
 */
export function useTeammateForm(
  profile: AgentProfile,
  onSave: (patch: Partial<AgentProfile>) => Promise<AgentProfile | null>
): TeammateForm {
  const [draft, setDraft] = useState<TeammateDraft>(() => draftOf(profile))
  const [saving, setSaving] = useState(false)

  const saved = useMemo(() => draftOf(profile), [profile])
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved])

  const set = <K extends keyof TeammateDraft>(key: K, value: TeammateDraft[K]): void =>
    setDraft((prev) => ({ ...prev, [key]: value }))

  const trimmedName = draft.name.trim()
  const scopeIncomplete = draft.scope === 'workspace' && !draft.workspacePath
  const canSave = Boolean(trimmedName) && !scopeIncomplete && dirty && !saving

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
        // A provider picked with no model id yet is ignored rather than sent —
        // the schema requires a non-empty model, so it would fail the save.
        model: usablePin(draft.model),
        autonomousMode: draft.autonomousMode,
        autoResumeOnLaunch: draft.autoResumeOnLaunch,
        scope: draft.scope,
        workspacePath: draft.scope === 'workspace' ? draft.workspacePath : undefined
      })
    } finally {
      setSaving(false)
    }
  }

  return {
    draft,
    set,
    setDraft,
    dirty,
    canSave,
    saving,
    reset: () => setDraft(draftOf(profile)),
    save
  }
}

/**
 * Bordered shell around a {@link Textarea}.
 *
 * The textarea's own chrome is `border-none bg-transparent` for the composer,
 * and `cn` does not merge Tailwind classes — appending `border` next to that
 * `border-none` sets a width against a style of `none`, which is how these
 * fields ended up reading as body copy rather than inputs. The border belongs
 * on a wrapper, where it can also carry focus-within.
 */
function Field({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-md border border-border bg-surface px-2.5 py-1 vy-transition',
        'hover:border-border-strong focus-within:border-border-strong focus-within:vy-focus-ring'
      )}
    >
      {children}
    </div>
  )
}

export function TeammateSettings({
  profile,
  form,
  secrets,
  ollamaBaseUrl,
  customOpenAiBaseUrl,
  openWorkspaces,
  activeWorkspacePath
}: {
  profile: AgentProfile
  form: TeammateForm
  secrets: Record<string, boolean>
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  openWorkspaces: string[]
  activeWorkspacePath: string | null
}) {
  const { draft, set, setDraft } = form
  const scopeIncomplete = draft.scope === 'workspace' && !draft.workspacePath

  return (
    <FormStack>
      <FormGroup title="Profile">
        <FormRow id="teammate-name" title="Name" hint="Shown wherever this teammate appears.">
          <div className="flex w-full items-center gap-2">
            <TeammateAvatarPicker
              name={draft.name}
              value={draft.avatar}
              onChange={(next) => set('avatar', next)}
            />
            <Input
              value={draft.name}
              aria-label="Name"
              className="min-w-0 flex-1"
              onChange={(e) => set('name', e.target.value)}
            />
          </div>
        </FormRow>
      </FormGroup>

      <FormGroup
        title="Instructions"
        description="Handed to the model at the start of every run, before your first message."
      >
        <FormRow
          id="teammate-persona"
          title="Persona"
          hint="What it is — the role it plays, and the lines it does not cross."
          wide
        >
          <Field>
            <Textarea
              value={draft.persona}
              aria-label="Persona"
              rows={3}
              className="max-h-60"
              placeholder="A terse senior frontend engineer who never touches backend files."
              onChange={(e) => set('persona', e.target.value)}
            />
          </Field>
        </FormRow>
        <FormRow
          id="teammate-identity"
          title="Identity"
          hint="What it knows — long-term context it carries into every run."
          wide
        >
          <Field>
            <Textarea
              value={draft.identity}
              aria-label="Identity"
              rows={3}
              className="max-h-60"
              placeholder="Owns the design system. Prefers pnpm. Runs vitest before claiming done."
              onChange={(e) => set('identity', e.target.value)}
            />
          </Field>
        </FormRow>
        <FormRow id="teammate-tone" title="Tone" hint="How it writes back to you." wide>
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
          hint="Every run bound to this teammate starts here. A model you pick by hand still wins for that run."
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
            onChange={(next) => set('autonomousMode', next as TeammateDraft['autonomousMode'])}
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
                const scope = next as TeammateDraft['scope']
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
                    the profile outside its workspace, so a task already queued
                    in another project fails when it starts. */}
                <p className="m-0 text-right text-2xs text-warning">
                  Chats and queued tasks for this teammate in other workspaces will stop working.
                </p>
              </>
            ) : null}
            {scopeIncomplete ? (
              <p className="m-0 text-right text-2xs text-danger" role="alert">
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
    </FormStack>
  )
}
