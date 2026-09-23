import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '@shared/ipc'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { DESKTOP_NOTIFICATION_OPTIONS } from '../constants'
import { SelectField } from '../components/SelectField'
import { SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'

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
          title="Enable notifications"
          hint="The sidebar inbox and desktop alerts."
          help="When off, nothing is added to the inbox and no desktop notifications are shown."
          checked={notifications.enabled}
          disabled={form.formLocked}
          onChange={(enabled) => patch({ enabled })}
        />
        <SelectField
          id="notifications-desktop"
          title="Desktop notifications"
          hint="When to also show a system notification."
          help="The inbox records every enabled event either way. When in background shows one only while the window is unfocused or minimized."
          value={notifications.desktop}
          options={DESKTOP_NOTIFICATION_OPTIONS}
          disabled={eventsLocked}
          onChange={(desktop) => patch({ desktop })}
        />
      </SettingsGroup>

      <SettingsGroup title="Events">
        <SwitchField
          id="notifications-run-finished"
          title="Agent run finished"
          hint="A run completes."
          checked={notifications.agentRunFinished}
          disabled={eventsLocked}
          onChange={(agentRunFinished) => patch({ agentRunFinished })}
        />
        <SwitchField
          id="notifications-run-failed"
          title="Agent run failed"
          hint="A run stops on an error."
          checked={notifications.agentRunFailed}
          disabled={eventsLocked}
          onChange={(agentRunFailed) => patch({ agentRunFailed })}
        />
        <SwitchField
          id="notifications-needs-you"
          title="Agent needs you"
          hint="An approval or a question is waiting on you."
          checked={notifications.agentNeedsYou}
          disabled={eventsLocked}
          onChange={(agentNeedsYou) => patch({ agentNeedsYou })}
        />
        <SwitchField
          id="notifications-system"
          title="System alerts"
          hint="Crash recovery and other app events."
          checked={notifications.system}
          disabled={eventsLocked}
          onChange={(system) => patch({ system })}
        />
      </SettingsGroup>
    </SettingsStack>
  )
}
