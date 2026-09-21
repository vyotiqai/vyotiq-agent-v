import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  FormGroup,
  FormRow,
  Input,
  Menu,
  Switch,
  Textarea,
  cn,
  pushToast
} from '@renderer/lib/ui'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { useWorkspaceProfileOverrides } from '@renderer/lib/hooks/useWorkspaceProfileOverrides'
import type { AgentProfile, AgentProfileOverride } from '@shared/ipc'
import { TeammateModelPin, usablePin, type ModelPin } from './TeammateModelPin'
import { workspaceLabel } from './teammatePresentation'

/**
 * Retune one teammate for one project.
 *
 * `resolveAgentProfile` merges `.vyotiq/agents/<id>.profile.json` over the
 * global profile for every run in that workspace. The file is git-shareable on
 * purpose — it is how a repo says "in here, this teammate works like this" —
 * and until now it could only be written by hand.
 *
 * The write REPLACES the file, so this carries through the fields it does not
 * itself edit. Dropping a hand-authored `avatar` because this form has no
 * control for it would be silent data loss.
 */

/** Fields this form edits. Anything else in the file is preserved untouched. */
const EDITED_KEYS = [
  'persona',
  'identity',
  'tone',
  'autonomousMode',
  'autoResumeOnLaunch',
  'model'
] as const

type EditedKey = (typeof EDITED_KEYS)[number]

const FIELD_LABEL: Record<EditedKey, string> = {
  persona: 'Persona',
  identity: 'Identity',
  tone: 'Tone',
  autonomousMode: 'Tool approvals',
  autoResumeOnLaunch: 'Auto-resume at launch',
  model: 'Pinned model'
}

/**
 * Plain-language name for a privileged field, for the accept prompt.
 *
 * `PRIVILEGED_OVERRIDE_FIELDS` is the main-side list, so an id that does not
 * appear in this form still reads as something rather than a raw key.
 */
function FIELD_LABEL_FOR(field: string): string {
  if (field === 'autonomousMode') return 'tool approvals'
  if (field === 'autoResumeOnLaunch') return 'auto-resume at launch'
  if (field === 'runtime') return 'where runs execute'
  return field
}

function overriddenCount(override: AgentProfileOverride | undefined): number {
  if (!override) return 0
  return Object.values(override).filter((v) => v !== undefined).length
}


export function TeammateOverrides({
  profile,
  openWorkspaces,
  secrets,
  ollamaBaseUrl,
  customOpenAiBaseUrl
}: {
  profile: AgentProfile
  openWorkspaces: string[]
  secrets: Record<string, boolean>
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
}) {
  const {
    byWorkspace,
    unacceptedByWorkspace,
    ensureLoaded,
    setOverride,
    acceptOverride,
    error,
    clearError
  } = useWorkspaceProfileOverrides()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentProfileOverride>({})
  /**
   * Which fields are switched on, held explicitly rather than inferred from
   * `draft[key] !== undefined`.
   *
   * Inference broke the model row: seeding it from a teammate with no global
   * pin stored `undefined`, which read back as "not overridden", so the switch
   * flipped itself straight off and the pin editor never appeared. Every other
   * field happened to seed to a defined value and hid the bug.
   */
  const [onKeys, setOnKeys] = useState<ReadonlySet<EditedKey>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const { confirm, dialog } = useConfirm()

  useEffect(() => {
    for (const path of openWorkspaces) ensureLoaded(path)
  }, [openWorkspaces, ensureLoaded])

  const current = editing ? (byWorkspace[editing]?.[profile.id] ?? {}) : {}

  const open = (path: string): void => {
    const stored = byWorkspace[path]?.[profile.id] ?? {}
    setDraft({ ...stored })
    // Same measure as `overriddenCount`, so the switches and the row badge can
    // never disagree about how many fields this file overrides.
    setOnKeys(new Set(EDITED_KEYS.filter((key) => stored[key] !== undefined)))
    setEditing(path)
  }

  const isOn = (key: EditedKey): boolean => onKeys.has(key)

  const toggle = (key: EditedKey, on: boolean): void => {
    setOnKeys((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
    setDraft((prev) => {
      const next = { ...prev }
      if (!on) {
        delete next[key]
        return next
      }
      // Seed from the global value so switching an override on does not
      // silently blank the field for that workspace.
      if (key === 'autonomousMode') next.autonomousMode = profile.autonomousMode ?? 'inherit'
      else if (key === 'autoResumeOnLaunch')
        next.autoResumeOnLaunch = profile.autoResumeOnLaunch ?? false
      else if (key === 'model') next.model = profile.model
      else next[key] = profile[key] ?? ''
      return next
    })
  }

  const save = async (): Promise<void> => {
    if (!editing || saving) return
    setSaving(true)
    try {
      // Preserve anything this form does not edit (a hand-authored avatar or
      // runtime), because the write replaces the whole file.
      const next: AgentProfileOverride = { ...current }
      for (const key of EDITED_KEYS) delete next[key]
      // Only switched-on fields are written, so a field toggled on and then off
      // again cannot leave its seeded value behind in the file.
      for (const key of EDITED_KEYS) {
        if (!onKeys.has(key)) continue
        const value = key === 'model' ? usablePin(draft.model) : draft[key]
        if (value === undefined) continue
        Object.assign(next, { [key]: value })
      }
      // `overriddenCount`, not `Object.keys`: a key whose value is `undefined`
      // is still a key, so the old gate wrote `{}` into the user's repository
      // instead of removing the file.
      const keep = overriddenCount(next) > 0
      const ok = await setOverride(editing, profile.id, keep ? next : null)
      if (!ok) return
      pushToast(
        keep
          ? `Override saved for ${workspaceLabel(editing)}`
          : `Override cleared for ${workspaceLabel(editing)}`
      )
      setEditing(null)
    } finally {
      setSaving(false)
    }
  }

  const accept = async (path: string): Promise<void> => {
    const withheld = unacceptedByWorkspace[path]?.[profile.id] ?? []
    const ok = await confirm(
      `Let ${workspaceLabel(path)} change ${withheld.map(FIELD_LABEL_FOR).join(' and ')} for ${profile.name}? This file came with the project. Accepting applies it until the file changes again.`,
      { title: `Accept ${workspaceLabel(path)}'s changes`, confirmLabel: 'Accept' }
    )
    if (!ok) return
    if (await acceptOverride(path, profile.id)) {
      pushToast(`Accepted ${workspaceLabel(path)}'s changes for ${profile.name}`)
    }
  }

  const clear = async (): Promise<void> => {
    if (!editing || saving) return
    setSaving(true)
    try {
      const ok = await setOverride(editing, profile.id, null)
      if (!ok) return
      pushToast(`Override cleared for ${workspaceLabel(editing)}`)
      setEditing(null)
    } finally {
      setSaving(false)
    }
  }

  const rows = useMemo(() => openWorkspaces.slice().sort(), [openWorkspaces])

  /**
   * A refused write left this silent: the store held the reason and nothing
   * read it, so Save appeared to work and the file never changed.
   *
   * It renders in two places because a failed save leaves the dialog OPEN, and
   * a banner behind a modal is no more visible than no banner at all.
   */
  const errorAlert = error ? (
    <Alert variant="danger" onDismiss={clearError} dismissLabel="Dismiss override warning">
      {error}
    </Alert>
  ) : null

  return (
    <>
      {editing == null ? errorAlert : null}
      <FormGroup
        title="Per-workspace tuning"
        description="A project can run a retuned copy of this teammate. It is written into that project as a shareable file."
      >
        {rows.length === 0 ? (
          <FormRow
            id="teammate-overrides-none"
            title="No project open"
            hint="Open one to tune this teammate for it."
          >
            <span className="text-2xs text-muted">—</span>
          </FormRow>
        ) : (
          rows.map((path) => {
            const count = overriddenCount(byWorkspace[path]?.[profile.id])
            const withheld = unacceptedByWorkspace[path]?.[profile.id] ?? []
            return (
              <FormRow
                key={path}
                id={`teammate-override-${path}`}
                title={workspaceLabel(path)}
                hint={
                  withheld.length
                    ? // These arrive over git, so the file may be asking for
                      // something the user never chose. Say what it wants
                      // rather than applying it quietly.
                      `This project is asking to change ${withheld.map(FIELD_LABEL_FOR).join(' and ')}. Not applied until you accept it.`
                    : count
                      ? 'Runs a retuned copy here.'
                      : 'Follows the settings above.'
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  {withheld.length ? (
                    <Badge tone="warning">
                      {withheld.length} change{withheld.length === 1 ? '' : 's'} not applied
                    </Badge>
                  ) : count ? (
                    <Badge tone="accent">
                      {count} field{count === 1 ? '' : 's'} overridden
                    </Badge>
                  ) : null}
                  {withheld.length ? (
                    <Button
                      variant="subtle"
                      onClick={() => void accept(path)}
                      aria-label={`Accept override for ${workspaceLabel(path)}`}
                    >
                      Review and accept
                    </Button>
                  ) : null}
                  <Button
                    variant="subtle"
                    onClick={() => open(path)}
                    aria-label={`Edit override for ${workspaceLabel(path)}`}
                  >
                    {count ? 'Edit' : 'Add override'}
                  </Button>
                </div>
              </FormRow>
            )
          })
        )}
      </FormGroup>

      <Dialog
        open={editing != null}
        onClose={() => {
          clearError()
          setEditing(null)
        }}
        title={editing ? `${profile.name} in ${workspaceLabel(editing)}` : 'Override'}
        size="lg"
      >
        <div className="flex flex-col gap-3">
          {errorAlert}
          <p className="m-0 text-2xs text-muted">
            Only the fields you switch on differ here. Everything else follows the teammate&apos;s
            global settings. This is written to the project as a shareable file.
          </p>

          {EDITED_KEYS.map((key) => (
            <div key={key} className="flex flex-col gap-1.5 rounded-md bg-surface p-2">
              <label className="flex items-center justify-between gap-2 text-xs text-fg">
                {FIELD_LABEL[key]}
                <Switch
                  checked={isOn(key)}
                  onCheckedChange={(next) => toggle(key, next)}
                  label={`Override ${FIELD_LABEL[key]}`}
                />
              </label>

              {isOn(key) ? (
                key === 'autonomousMode' ? (
                  <Menu
                    value={draft.autonomousMode ?? 'inherit'}
                    options={[
                      { value: 'inherit', label: 'Follow the app setting' },
                      { value: 'on', label: 'Always autonomous' },
                      { value: 'off', label: 'Always ask before tools' }
                    ]}
                    aria-label="Tool approvals override"
                    placement="down"
                    onChange={(next) =>
                      setDraft((prev) => ({
                        ...prev,
                        autonomousMode: next as 'inherit' | 'on' | 'off'
                      }))
                    }
                  />
                ) : key === 'autoResumeOnLaunch' ? (
                  <Switch
                    checked={draft.autoResumeOnLaunch ?? false}
                    onCheckedChange={(next) =>
                      setDraft((prev) => ({ ...prev, autoResumeOnLaunch: next }))
                    }
                    label="Auto-resume interrupted runs in this workspace"
                    size="md"
                  />
                ) : key === 'model' ? (
                  <TeammateModelPin
                    value={draft.model as ModelPin | undefined}
                    onChange={(next) => setDraft((prev) => ({ ...prev, model: next }))}
                    secrets={secrets}
                    ollamaBaseUrl={ollamaBaseUrl}
                    customOpenAiBaseUrl={customOpenAiBaseUrl}
                  />
                ) : key === 'tone' ? (
                  <Input
                    value={draft.tone ?? ''}
                    aria-label="Tone override"
                    onChange={(e) => setDraft((prev) => ({ ...prev, tone: e.target.value }))}
                  />
                ) : (
                  // The border lives on the wrapper: Textarea's own chrome is
                  // `border-none`, and `cn` does not merge Tailwind classes, so
                  // a `border` appended here sets a width against a style of
                  // none and nothing is drawn.
                  <div
                    className={cn(
                      'rounded-md border border-border bg-bg px-2.5 py-1 vy-transition',
                      'focus-within:border-border-strong focus-within:vy-focus-ring'
                    )}
                  >
                    <Textarea
                      value={(draft[key] as string | undefined) ?? ''}
                      rows={3}
                      aria-label={`${FIELD_LABEL[key]} override`}
                      className="max-h-60"
                      onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                    />
                  </div>
                )
              ) : null}
            </div>
          ))}

          <div className="flex items-center justify-end gap-2">
            {overriddenCount(current) > 0 ? (
              <Button variant="danger" className="mr-auto" onClick={() => void clear()}>
                Remove override
              </Button>
            ) : null}
            <Button variant="subtle" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} pending={saving}>
              Save override
            </Button>
          </div>
        </div>
      </Dialog>
      {dialog}
    </>
  )
}
