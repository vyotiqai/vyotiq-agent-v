import { useEffect, useRef, useState } from 'react'
import { Menu } from '@renderer/lib/ui/Menu'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Icon } from '@renderer/lib/icons'
import { pushToast } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/ui/cn'
import { chromePillButton } from './composerChrome'
import { useAgentProfiles } from '@renderer/lib/hooks/useAgentProfiles'

/**
 * Teammate profile picker — binds the current chat to a persistent agent
 * profile (identity + per-profile memory). Also creates teammates inline.
 */
export function AgentProfilePicker({
  profileId,
  onProfileChange,
  disabled,
  className
}: {
  profileId: string | null
  onProfileChange: (profileId: string | null) => void
  disabled?: boolean
  className?: string
}) {
  const { profiles, createProfile, deleteProfile } = useAgentProfiles()
  const [createOpen, setCreateOpen] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (createOpen) nameInputRef.current?.focus()
  }, [createOpen])
  const [name, setName] = useState('')
  const [persona, setPersona] = useState('')
  const [tone, setTone] = useState('')
  const [identity, setIdentity] = useState('')
  const [saving, setSaving] = useState(false)

  const bound = profiles.find((p) => p.id === profileId) ?? null
  const options = [
    { value: '__none__', label: 'No teammate (default agent)' },
    ...profiles.map((p) => ({ value: p.id, label: p.name, group: 'Teammates' })),
    { value: '__create__', label: 'New teammate…' }
  ]

  const submitCreate = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    const created = await createProfile({
      name: trimmed,
      scope: 'global',
      ...(persona.trim() ? { persona: persona.trim() } : {}),
      ...(tone.trim() ? { tone: tone.trim() } : {}),
      ...(identity.trim() ? { identity: identity.trim() } : {})
    })
    setSaving(false)
    if (created) {
      pushToast(`Teammate "${created.name}" created`)
      onProfileChange(created.id)
      setCreateOpen(false)
      setName('')
      setPersona('')
      setTone('')
      setIdentity('')
    } else {
      pushToast('Could not create teammate')
    }
  }

  const removeProfile = async (id: string): Promise<void> => {
    const target = profiles.find((p) => p.id === id)
    const ok = await deleteProfile(id)
    if (ok) {
      pushToast(`Teammate "${target?.name ?? id}" deleted`)
      if (profileId === id) onProfileChange(null)
    }
  }

  return (
    <div className={cn('relative flex h-7 shrink-0 items-center', className)}>
      <Menu
        aria-label="Teammate"
        value={profileId ?? '__none__'}
        options={options}
        disabled={disabled}
        triggerClassName={cn(chromePillButton, 'text-fg max-w-40')}
        onChange={(next) => {
          if (next === '__create__') {
            setCreateOpen(true)
            return
          }
          if (next === '__none__') {
            onProfileChange(null)
            return
          }
          onProfileChange(next)
        }}
      />
      {bound ? (
        <span
          className="ml-0.5 inline-block size-1.5 shrink-0 rounded-full bg-accent"
          aria-hidden
          title={`Bound to ${bound.name}`}
        />
      ) : null}
      {bound ? (
        <button
          type="button"
          className="ml-0.5 inline-grid size-5 shrink-0 place-items-center rounded text-muted vy-transition hover:text-danger"
          aria-label={`Delete teammate ${bound.name}`}
          disabled={disabled}
          onClick={() => {
            void removeProfile(bound.id)
          }}
        >
          <Icon name="trash" size={12} />
        </button>
      ) : null}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New teammate"
      >
        <div className="flex min-w-80 flex-col gap-3 p-1">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Name
            <input
              ref={nameInputRef}
              className="min-h-8 rounded-md border border-border bg-surface px-2 text-sm text-fg outline-none focus:border-accent"
              value={name}
              placeholder="Frontend Fixer"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitCreate()
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Persona (what this teammate is)
            <textarea
              className="min-h-16 resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
              value={persona}
              placeholder="A terse senior frontend engineer who never touches backend files."
              onChange={(e) => setPersona(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Identity (long-term context it should remember)
            <textarea
              className="min-h-16 resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
              value={identity}
              placeholder="Owns the design system. Prefers pnpm. Runs vitest before claiming done."
              onChange={(e) => setIdentity(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Tone (how it responds)
            <input
              className="min-h-8 rounded-md border border-border bg-surface px-2 text-sm text-fg outline-none focus:border-accent"
              value={tone}
              placeholder="Direct, no filler, code first."
              onChange={(e) => setTone(e.target.value)}
            />
          </label>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="min-h-8 rounded-md border border-border px-3 text-xs text-fg vy-transition hover:bg-surface-2"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="min-h-8 rounded-md bg-accent px-3 text-xs font-medium text-fg vy-transition hover:opacity-90 disabled:opacity-50"
              disabled={!name.trim() || saving}
              onClick={() => void submitCreate()}
            >
              Create teammate
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
