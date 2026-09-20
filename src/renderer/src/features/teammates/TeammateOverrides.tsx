import { useEffect, useMemo, useState } from 'react'
import {
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
import { useWorkspaceProfileOverrides } from '@renderer/lib/hooks/useWorkspaceProfileOverrides'
import type { AgentProfile, AgentProfileOverride } from '@shared/ipc'
import { TeammateModelPin, type ModelPin } from './TeammateModelPin'
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
  const { byWorkspace, ensureLoaded, setOverride } = useWorkspaceProfileOverrides()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentProfileOverride>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    for (const path of openWorkspaces) ensureLoaded(path)
  }, [openWorkspaces, ensureLoaded])

  const current = editing ? (byWorkspace[editing]?.[profile.id] ?? {}) : {}

  const open = (path: string): void => {
    setDraft({ ...(byWorkspace[path]?.[profile.id] ?? {}) })
    setEditing(path)
  }

  const isOn = (key: EditedKey): boolean => draft[key] !== undefined

  const toggle = (key: EditedKey, on: boolean): void => {
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
      const preserved: AgentProfileOverride = { ...current }
      for (const key of EDITED_KEYS) delete preserved[key]
      const next: AgentProfileOverride = { ...preserved, ...draft }
      const ok = await setOverride(
        editing,
        profile.id,
        Object.keys(next).length > 0 ? next : null
      )
      if (!ok) return
      pushToast(
        Object.keys(next).length > 0
          ? `Override saved for ${workspaceLabel(editing)}`
          : `Override cleared for ${workspaceLabel(editing)}`
      )
      setEditing(null)
    } finally {
      setSaving(false)
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

  return (
    <>
      <FormGroup title="Per-workspace overrides">
        {rows.length === 0 ? (
          <FormRow
            id="teammate-overrides-none"
            title="No workspace open"
            hint="Open a project to tune this teammate for it."
          >
            <span className="text-2xs text-muted">—</span>
          </FormRow>
        ) : (
          rows.map((path) => {
            const count = overriddenCount(byWorkspace[path]?.[profile.id])
            return (
              <FormRow
                key={path}
                id={`teammate-override-${path}`}
                title={workspaceLabel(path)}
                hint={
                  count
                    ? 'This project runs a retuned copy of this teammate.'
                    : 'Uses the global settings above.'
                }
              >
                <div className="flex items-center gap-2">
                  {count ? (
                    <Badge tone="accent">
                      {count} field{count === 1 ? '' : 's'} overridden
                    </Badge>
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
        onClose={() => setEditing(null)}
        title={editing ? `${profile.name} in ${workspaceLabel(editing)}` : 'Override'}
        size="lg"
      >
        <div className="flex flex-col gap-3">
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
                  <Textarea
                    value={(draft[key] as string | undefined) ?? ''}
                    rows={3}
                    aria-label={`${FIELD_LABEL[key]} override`}
                    className={cn('resize-y rounded-md border border-border bg-bg px-2 py-1.5')}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
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
    </>
  )
}
