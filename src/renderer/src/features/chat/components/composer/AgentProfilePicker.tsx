import { useMemo, useRef, useState } from 'react'
import { Button, Input, Menu, cn, pushToast } from '@renderer/lib/ui'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { IconButton } from '@renderer/lib/ui/IconButton'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { useAgentProfiles } from '@renderer/lib/hooks/useAgentProfiles'
import {
  isProfileUsableIn,
  unusableReason
} from '@renderer/features/teammates/teammatePresentation'
import { chromePillButton } from './composerChrome'

/**
 * Teammate pill — binds the current chat to a persistent agent profile.
 *
 * Creating here asks only for a name and binds immediately; persona, identity,
 * tone, the model pin and availability live in the Teammates pane. This used
 * to be a second four-field form that silently omitted auto-resume, so the two
 * create paths produced different teammates.
 */
export function AgentProfilePicker({
  profileId,
  onProfileChange,
  workspacePath = null,
  disabled,
  className
}: {
  profileId: string | null
  onProfileChange: (profileId: string | null) => void
  /** Used to hide teammates that cannot run in this workspace. */
  workspacePath?: string | null
  disabled?: boolean
  className?: string
}) {
  const { profiles, createProfile, deleteProfile } = useAgentProfiles()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const bound = profiles.find((p) => p.id === profileId) ?? null

  /**
   * Only teammates that can actually run here. `resolveAgentProfile` returns
   * null for a workspace-scoped profile outside its own workspace, so binding
   * one would fail the whole send with `Unknown agent profile` — about a
   * teammate this menu had just offered.
   */
  const selectable = useMemo(
    () => profiles.filter((p) => isProfileUsableIn(p, workspacePath)),
    [profiles, workspacePath]
  )

  const options = [
    { value: '__none__', label: 'No teammate (default agent)' },
    ...selectable.map((p) => ({ value: p.id, label: p.name, group: 'Teammates' })),
    { value: '__create__', label: 'New teammate…' }
  ]
  // A binding made before the teammate was narrowed to another workspace still
  // has to be visible, or the pill would read as unbound while the run is not.
  if (bound && !selectable.some((p) => p.id === bound.id)) {
    options.splice(1, 0, { value: bound.id, label: bound.name, group: 'Teammates' })
  }

  const submitCreate = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      const created = await createProfile({ name: trimmed, scope: 'global' })
      if (!created) {
        pushToast('Could not create teammate', 'error')
        return
      }
      pushToast(`Teammate "${created.name}" created`)
      onProfileChange(created.id)
      setCreateOpen(false)
      setName('')
    } finally {
      setSaving(false)
    }
  }

  const removeProfile = async (id: string): Promise<void> => {
    const target = profiles.find((p) => p.id === id)
    // Deletion stops queued and running work. It used to happen on one
    // unconfirmed click, next to the pill you use constantly.
    const ok = await confirm(
      `Delete ${target?.name ?? 'this teammate'}? Queued and running work stops. Its memory and past runs are kept.`,
      { title: `Delete ${target?.name ?? 'teammate'}`, confirmLabel: 'Delete', danger: true }
    )
    if (!ok) return
    const result = await deleteProfile(id)
    if (!result) {
      pushToast('Could not delete teammate', 'error')
      return
    }
    pushToast(`Teammate "${target?.name ?? id}" deleted`)
    if (profileId === id) onProfileChange(null)
  }

  const boundBlocked = bound ? unusableReason(bound, workspacePath) : null

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
          onProfileChange(next === '__none__' ? null : next)
        }}
      />
      {bound ? (
        <span
          className={cn(
            'ml-0.5 inline-block size-1.5 shrink-0 rounded-full',
            boundBlocked ? 'bg-warning' : 'bg-accent'
          )}
          aria-hidden
          title={boundBlocked ?? `Bound to ${bound.name}`}
        />
      ) : null}
      {bound ? (
        <IconButton
          icon="trash"
          size="xs"
          label={`Delete teammate ${bound.name}`}
          className="ml-0.5 hover:!text-danger"
          disabled={disabled}
          onClick={() => void removeProfile(bound.id)}
        />
      ) : null}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New teammate"
        initialFocusRef={nameInputRef}
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Name
            <Input
              ref={nameInputRef}
              value={name}
              placeholder="Frontend Fixer"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitCreate()
              }}
            />
          </label>
          <p className="m-0 text-2xs text-muted">
            Binds to this chat straight away. Persona, model and availability are in
            Teammates.
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="subtle" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submitCreate()} disabled={!name.trim() || saving}>
              Create teammate
            </Button>
          </div>
        </div>
      </Dialog>
      {confirmDialog}
    </div>
  )
}
