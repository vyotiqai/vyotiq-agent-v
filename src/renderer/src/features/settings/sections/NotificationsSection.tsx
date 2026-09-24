import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '@shared/ipc'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { DESKTOP_NOTIFICATION_OPTIONS } from '../constants'
import { SelectField } from '../components/SelectField'
import { SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'

/** Whose notifications a desktop alert is. */
function desktopName(): string {
  const platform = window.vyotiq?.platform
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  return 'Desktop'
}

export function NotificationsSection({ form }: { form: SettingsFormState }) {
  const notifications = form.settings.notifications ?? DEFAULT_NOTIFICATION_SETTINGS
  const eventsLocked = form.formLocked || !notifications.enabled
  const patch = (partial: Partial<NotificationSettings>): void => {
    void form.runUpdate({ notifications: { ...notifications, ...partial } })
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Delivery">
        <SwitchField
          id="notifications-enabled"
          title="Notifications"
          hint="The inbox and desktop alerts."
          checked={notifications.enabled}
          disabled={form.formLocked}
          onChange={(enabled) => patch({ enabled })}
          {...form.nestedDefaultMark('notifications', 'enabled')}
        />
        <SelectField
          id="notifications-desktop"
          title="Desktop alerts"
          hint={`${desktopName()} notifications, on top of the inbox.`}
          value={notifications.desktop}
          options={DESKTOP_NOTIFICATION_OPTIONS}
          disabled={eventsLocked}
          onChange={(desktop) => patch({ desktop })}
          {...form.nestedDefaultMark('notifications', 'desktop')}
        />
      </SettingsGroup>

      <SettingsGroup title="Events">
        <SwitchField
          id="notifications-needs-you"
          title="A task needs you"
          checked={notifications.agentNeedsYou}
          disabled={eventsLocked}
          onChange={(agentNeedsYou) => patch({ agentNeedsYou })}
          {...form.nestedDefaultMark('notifications', 'agentNeedsYou')}
        />
        <SwitchField
          id="notifications-run-finished"
          title="A task finished"
          checked={notifications.agentRunFinished}
          disabled={eventsLocked}
          onChange={(agentRunFinished) => patch({ agentRunFinished })}
          {...form.nestedDefaultMark('notifications', 'agentRunFinished')}
        />
        <SwitchField
          id="notifications-run-failed"
          title="A task failed"
          checked={notifications.agentRunFailed}
          disabled={eventsLocked}
          onChange={(agentRunFailed) => patch({ agentRunFailed })}
          {...form.nestedDefaultMark('notifications', 'agentRunFailed')}
        />
        <SwitchField
          id="notifications-system"
          title="System alerts"
          hint="When the window recovers from a crash."
          checked={notifications.system}
          disabled={eventsLocked}
          onChange={(system) => patch({ system })}
          {...form.nestedDefaultMark('notifications', 'system')}
        />
      </SettingsGroup>
    </SettingsStack>
  )
}
