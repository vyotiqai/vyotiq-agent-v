import { useEffect, useState } from 'react'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Button, Keys, cn } from '@renderer/lib/ui'
import { BORDER_DIVIDER, SECTION_LABEL } from '@renderer/lib/utils/layout'
import {
  SHORTCUT_BINDINGS,
  getBinding,
  isEditableShortcutTarget,
  matchShortcut,
  shouldBlockAppShortcut,
  useShortcutsVersion,
  type ShortcutId
} from '@renderer/lib/shortcuts'
import { chordKeys, shortcutGroups } from '@renderer/features/settings/utils/shortcutGroups'
import { onShortcutsHelpRequest, openDocumentation } from './helpRequests'

/** True for a bare `?` — Shift+/ on most layouts — with no Ctrl, Cmd or Alt. */
export function isHelpKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey
}

/** A shortcut the user rebound in Settings → Shortcuts. */
function isRebound(id: string): boolean {
  return id in SHORTCUT_BINDINGS && getBinding(id as ShortcutId) !== SHORTCUT_BINDINGS[id as ShortcutId]
}

/**
 * Every keyboard shortcut, grouped by what it acts on — the same groups and
 * the same registry as Settings → Shortcuts, so a rebound chord shows its new
 * keys here. Opens on Ctrl/Cmd+/ (rebindable), on `?` outside a text field,
 * and from the command palette.
 */
export function ShortcutsHelpDialog({ onOpenShortcutSettings }: { onOpenShortcutSettings?: () => void }) {
  const [open, setOpen] = useState(false)
  useShortcutsVersion()

  useEffect(() => onShortcutsHelpRequest(() => setOpen(true)), [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat || e.defaultPrevented || e.isComposing) return
      if (matchShortcut(e, 'shortcutsHelp')) {
        if (shouldBlockAppShortcut(e.target)) return
        e.preventDefault()
        setOpen((was) => !was)
        return
      }
      // `?` is a character: anywhere text goes in, the composer included, it is typed.
      if (isHelpKey(e) && !isEditableShortcutTarget(e.target)) {
        e.preventDefault()
        setOpen((was) => !was)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const close = (): void => setOpen(false)
  const groups = open ? shortcutGroups() : []

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Keyboard shortcuts"
      icon="keyboard"
      useNativeDialog={false}
      padded={false}
      className="vy-menu flex w-[min(46rem,calc(100vw_-_2rem))] flex-col overflow-hidden"
      footer={
        <>
          <Button
            size="sm"
            variant="ghost"
            icon="book"
            onClick={openDocumentation}
          >
            Documentation
          </Button>
          <span className="flex-1" />
          {onOpenShortcutSettings ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                close()
                onOpenShortcutSettings()
              }}
            >
              Change shortcuts
            </Button>
          ) : null}
        </>
      }
    >
      <div data-shortcuts-help className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          {groups.map((group) => (
            <section key={group.title} className="mt-4 min-w-0" aria-label={group.title}>
              <h3 className={cn('mb-1', SECTION_LABEL)}>{group.title}</h3>
              <ul className="m-0 list-none p-0">
                {group.entries.map((entry) => {
                  const rebound = isRebound(entry.id)
                  return (
                    <li
                      key={entry.id}
                      data-shortcut-row={entry.id}
                      className={cn('flex h-8 items-center gap-3 border-b text-sm', BORDER_DIVIDER)}
                    >
                      <span
                        className={cn('min-w-0 flex-1 truncate', rebound ? 'text-fg-strong' : 'text-muted')}
                        title={entry.title}
                      >
                        {entry.title}
                      </span>
                      <Keys keys={chordKeys(entry.label)} className="shrink-0" />
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Dialog>
  )
}
