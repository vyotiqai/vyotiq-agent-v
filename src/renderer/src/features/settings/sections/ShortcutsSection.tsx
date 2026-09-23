import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { shortcutGroups } from '../utils/shortcutGroups'

export function ShortcutsSection() {
  return (
    <div data-settings-field="shortcuts">
      <SettingsStack>
        {shortcutGroups().map((group) => (
          <SettingsGroup key={group.title} title={group.title}>
            {group.entries.map((entry) => (
              <SettingsField key={entry.id} id={`shortcut-${entry.id}`} title={entry.title}>
                <kbd className="rounded-md bg-bg px-1.5 py-0.5 font-mono text-xs text-fg">
                  {entry.label}
                </kbd>
              </SettingsField>
            ))}
          </SettingsGroup>
        ))}
      </SettingsStack>
    </div>
  )
}
