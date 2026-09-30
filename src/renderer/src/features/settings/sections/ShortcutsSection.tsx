import { useEffect, useState } from 'react'
import { Button, Keys, cn } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import {
  chordFromEvent,
  findShortcutConflict,
  isRebindable,
  reservedChordReason,
  SHORTCUT_TITLES,
  useShortcutsVersion,
  type ShortcutChord,
  type ShortcutId
} from '@renderer/lib/shortcuts'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { chordKeys, shortcutGroups } from '../utils/shortcutGroups'

/**
 * Every chord, grouped by what it acts on, as keycaps — two columns, so the
 * whole list is in view at once. A rebindable row takes a new chord: Change,
 * then press it; one another shortcut already uses, or one the system owns,
 * is refused with the reason. The rows are search targets one by one; the
 * list as a whole is `shortcuts`.
 */
export function ShortcutsSection({ form }: { form?: SettingsFormState }) {
  useShortcutsVersion()
  const [recording, setRecording] = useState<ShortcutId | null>(null)
  const [error, setError] = useState<{ id: ShortcutId; message: string } | null>(null)
  const overrides = form?.settings.shortcutOverrides ?? {}
  const darwin = typeof window !== 'undefined' && window.vyotiq?.platform === 'darwin'

  const save = (next: Record<string, ShortcutChord>): void => {
    void form?.runUpdate({ shortcutOverrides: next })
  }

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      const chord = chordFromEvent(e)
      if (!chord) return
      const reserved = reservedChordReason(chord, darwin)
      if (reserved) {
        setError({ id: recording, message: reserved })
        setRecording(null)
        return
      }
      const clash = findShortcutConflict(recording, chord)
      if (clash) {
        setError({ id: recording, message: `${SHORTCUT_TITLES[clash]} already uses it.` })
        setRecording(null)
        return
      }
      setError(null)
      save({ ...overrides, [recording]: chord })
      setRecording(null)
    }
    // Capture, so the chord being recorded doesn't also run its old command.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const anyOverride = Object.keys(overrides).length > 0

  return (
    <div data-settings-field="shortcuts" className="mt-6">
      {form ? (
        <div className="flex h-7 items-center gap-2 text-xs text-muted">
          <span className="min-w-0 flex-1">Change a shortcut, then press the keys you want. Esc cancels.</span>
          {anyOverride ? (
            <Button size="xs" variant="ghost" disabled={form.formLocked} onClick={() => save({})}>
              Reset all shortcuts
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
        {shortcutGroups().map((group) => (
          <section key={group.title} className="mt-4">
            <h2 className={cn('mb-1', SECTION_LABEL)}>{group.title}</h2>
            {group.entries.map((entry) => {
              const id = entry.id as ShortcutId
              const rebindable = Boolean(form) && isRebindable(id)
              const changed = rebindable && id in overrides
              const listening = recording === id
              const rowError = error?.id === id ? error.message : null
              return (
                <div key={entry.id} data-settings-field={`shortcut-${entry.id}`} className="border-b border-border">
                  <div className="flex h-9 items-center gap-3 text-sm text-fg">
                    <span className={cn('min-w-0 flex-1 truncate', changed ? 'text-fg-strong' : undefined)}>{entry.title}</span>
                    {listening ? (
                      <span className="shrink-0 text-xs text-accent" role="status">
                        Press keys…
                      </span>
                    ) : (
                      <Keys keys={chordKeys(entry.label)} />
                    )}
                    {rebindable ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Change the shortcut for ${entry.title}`}
                          disabled={form!.formLocked}
                          onClick={() => {
                            setError(null)
                            setRecording(listening ? null : id)
                          }}
                        >
                          {listening ? 'Cancel' : 'Change'}
                        </Button>
                        {changed ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-label={`Reset the shortcut for ${entry.title}`}
                            disabled={form!.formLocked}
                            onClick={() => {
                              const { [id]: _drop, ...rest } = overrides
                              void _drop
                              save(rest)
                            }}
                          >
                            Reset
                          </Button>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                  {rowError ? (
                    <p className="m-0 pb-2 text-xs text-danger" role="alert">
                      {rowError}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </section>
        ))}
      </div>
    </div>
  )
}
