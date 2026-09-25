import { Keys, cn } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { chordKeys, shortcutGroups } from '../utils/shortcutGroups'

/**
 * Every chord, grouped by what it acts on, as keycaps — two columns, so the
 * whole list is in view at once. The rows are search targets one by one; the
 * list as a whole is `shortcuts`.
 */
export function ShortcutsSection() {
  return (
    <div data-settings-field="shortcuts" className="mt-6 grid grid-cols-1 gap-x-10 md:grid-cols-2">
      {shortcutGroups().map((group) => (
        <section key={group.title} className="mt-4">
          <h2 className={cn('mb-1', SECTION_LABEL)}>{group.title}</h2>
          {group.entries.map((entry) => (
            <div
              key={entry.id}
              data-settings-field={`shortcut-${entry.id}`}
              className="flex h-9 items-center gap-3 border-b border-border text-sm text-fg"
            >
              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
              <Keys keys={chordKeys(entry.label)} />
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
