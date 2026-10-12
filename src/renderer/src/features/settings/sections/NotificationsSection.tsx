import { DEFAULT_NOTIFICATION_SETTINGS, DEFAULT_QUIET_HOURS, type NotificationSettings } from '@shared/ipc'
import { Input } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { DESKTOP_NOTIFICATION_OPTIONS } from '../constants'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'
import { RemoteNotificationsGroup } from '../components/RemoteNotificationsGroup'

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
  const quiet = notifications.quietHours ?? DEFAULT_QUIET_HOURS
  const desktopLocked = eventsLocked || notifications.desktop === 'off'

  return (
    <SettingsStack>
      <SettingsGroup title="Delivery">
        <SwitchField
          id="notifications-enabled"
          title="Notifications"
          hint="The inbox, toasts in the window, desktop alerts, and what screen readers announce."
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
        <SwitchField
          id="notifications-sound"
          title="Sound"
          hint="Desktop alerts play the system sound."
          checked={notifications.sound ?? false}
          disabled={desktopLocked}
          onChange={(sound) => patch({ sound })}
          {...form.nestedDefaultMark('notifications', 'sound')}
        />
        <SwitchField
          id="notifications-quiet-hours"
          title="Quiet hours"
          hint="No desktop alerts in these hours. The inbox still fills."
          checked={quiet.enabled}
          disabled={desktopLocked}
          onChange={(enabled) => patch({ quietHours: { ...quiet, enabled } })}
          {...form.nestedDefaultMark('notifications', 'quietHours')}
        />
        {quiet.enabled ? (
          <SettingsField id="notifications-quiet-hours-range" title="From and to" nested hint="Local time; a range can run past midnight.">
            <div className="flex items-center gap-1.5">
              {/* Width from the wrapper: Input is w-full and cn() has no merge. */}
              <div className="w-28">
                <Input
                  type="time"
                  size="sm"
                  aria-label="Quiet from"
                  value={quiet.start}
                  disabled={desktopLocked}
                  onChange={(e) => {
                    if (/^\d{2}:\d{2}$/.test(e.target.value)) patch({ quietHours: { ...quiet, start: e.target.value } })
                  }}
                />
              </div>
              <span className="text-xs text-tertiary">to</span>
              <div className="w-28">
                <Input
                  type="time"
                  size="sm"
                  aria-label="Quiet until"
                  value={quiet.end}
                  disabled={desktopLocked}
                  onChange={(e) => {
                    if (/^\d{2}:\d{2}$/.test(e.target.value)) patch({ quietHours: { ...quiet, end: e.target.value } })
                  }}
                />
              </div>
            </div>
          </SettingsField>
        ) : null}
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
          hint="When the window recovers from a crash, an update is ready to install, or spend reaches a budget."
          checked={notifications.system}
          disabled={eventsLocked}
          onChange={(system) => patch({ system })}
          {...form.nestedDefaultMark('notifications', 'system')}
        />
      </SettingsGroup>

      <RemoteNotificationsGroup form={form} />
    </SettingsStack>
  )
}
