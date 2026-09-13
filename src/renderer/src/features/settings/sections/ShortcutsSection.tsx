import { shortcutCatalog } from '@renderer/lib/shortcuts'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

export function ShortcutsSection() {
  const entries = shortcutCatalog()
  return (
    <div data-settings-field="shortcuts">
      <SettingsStack>
        <SettingsGroup title="Keyboard">
          {entries.map((entry) => (
            <SettingsField key={entry.id} id={`shortcut-${entry.id}`} title={entry.title}>
              <kbd className="rounded-md bg-bg px-1.5 py-0.5 font-mono text-xs text-fg">
                {entry.label}
              </kbd>
            </SettingsField>
          ))}
        </SettingsGroup>
      </SettingsStack>
    </div>
  )
}
