import { useEffect, useState } from 'react'
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings, type RemoteNotificationMode } from '@shared/ipc'
import { Button, Input } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsOption } from '../types'
import { SegmentedField } from './SegmentedField'
import { SelectField } from './SelectField'
import { SettingsField, SettingsGroup } from './SettingsField'

const REMOTE_OPTIONS: SettingsOption<RemoteNotificationMode>[] = [
  { value: 'off', label: 'Off' },
  { value: 'ntfy', label: 'ntfy' },
  { value: 'webhook', label: 'Webhook' }
]

const WHEN_OPTIONS: SettingsOption<'away' | 'always'>[] = [
  { value: 'away', label: 'When away' },
  { value: 'always', label: 'Always' }
]

const PLACEHOLDER: Record<Exclude<RemoteNotificationMode, 'off'>, string> = {
  ntfy: 'https://ntfy.sh/your-topic',
  webhook: 'https://hooks.slack.com/services/…'
}

type TestState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'failed'; message: string }

/**
 * Notifications on a phone: the same events as the inbox, sent to an ntfy
 * topic or a webhook while you're away from this computer. The address is a
 * secret (anyone with it can post to you), so it goes to the key vault.
 */
export function RemoteNotificationsGroup({ form }: { form: SettingsFormState }) {
  const notifications = form.settings.notifications ?? DEFAULT_NOTIFICATION_SETTINGS
  const mode = notifications.remote ?? 'off'
  const locked = form.formLocked || !notifications.enabled
  const [address, setAddress] = useState('')
  const [saved, setSaved] = useState(false)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    void window.vyotiq?.toolSecretStatus?.().then((res) => {
      if (!cancelled && res?.ok) setSaved(res.data.notify === true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const patch = (partial: Partial<NotificationSettings>): void => {
    void form.runUpdate({ notifications: { ...notifications, ...partial } })
  }

  const saveAddress = async (): Promise<void> => {
    if (!address.trim()) return
    const res = await window.vyotiq.toolSecretSet({ name: 'notify', key: address.trim() })
    if (res.ok) {
      setSaved(res.data.notify === true)
      setAddress('')
      setTest({ kind: 'idle' })
    }
  }
  const clearAddress = async (): Promise<void> => {
    const res = await window.vyotiq.toolSecretClear({ name: 'notify' })
    if (res.ok) setSaved(res.data.notify === true)
  }
  const sendTest = async (): Promise<void> => {
    if (mode === 'off') return
    setTest({ kind: 'sending' })
    const res = await window.vyotiq.notificationsRemoteTest({ mode, ...(address.trim() ? { url: address.trim() } : {}) })
    setTest(res.ok ? { kind: 'sent' } : { kind: 'failed', message: res.error })
  }

  return (
    <SettingsGroup title="On your phone" description="The same events, sent off this computer.">
      <SelectField
        id="notifications-remote"
        title="Send to your phone"
        hint={
          mode === 'ntfy'
            ? 'An ntfy topic: install the ntfy app and subscribe to the same topic. Pick a name nobody would guess.'
            : mode === 'webhook'
              ? 'A JSON POST that Slack, Discord, Teams or your own script can take.'
              : 'Nothing leaves this computer.'
        }
        value={mode}
        options={REMOTE_OPTIONS}
        width={160}
        disabled={locked}
        onChange={(remote) => {
          setTest({ kind: 'idle' })
          patch({ remote })
        }}
        {...form.nestedDefaultMark('notifications', 'remote')}
      />
      {mode !== 'off' ? (
        <>
          <SettingsField
            id="notifications-remote-url"
            title="Address"
            hint={saved ? 'Saved in the key vault.' : 'Kept in the key vault, never in settings.json.'}
            nested
          >
            <div className="flex w-[280px] items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <Input
                  size="sm"
                  mono
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Notification address"
                  placeholder={saved ? '••••••••' : PLACEHOLDER[mode]}
                  disabled={locked}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveAddress()
                  }}
                />
              </div>
              {address ? (
                <Button size="sm" variant="secondary" onClick={() => void saveAddress()}>
                  Save
                </Button>
              ) : saved ? (
                <Button size="sm" variant="ghost" onClick={() => void clearAddress()}>
                  Clear
                </Button>
              ) : null}
            </div>
          </SettingsField>
          <SegmentedField
            id="notifications-remote-when"
            title="When"
            hint={
              notifications.remoteWhen === 'always'
                ? 'Every notification, even while you are looking at the window.'
                : 'Only while the window is in the background, minimized or in the tray. Quiet hours apply.'
            }
            value={notifications.remoteWhen ?? 'away'}
            options={WHEN_OPTIONS}
            disabled={locked}
            onChange={(remoteWhen) => patch({ remoteWhen })}
            nested
            {...form.nestedDefaultMark('notifications', 'remoteWhen')}
          />
          <SettingsField
            id="notifications-remote-test"
            title="Check it"
            hint="Sends one message now."
            nested
            below={
              test.kind === 'sent' ? (
                <p className="m-0 text-xs text-success" role="status">
                  Sent. It should be on your phone in a few seconds.
                </p>
              ) : test.kind === 'failed' ? (
                <p className="m-0 text-xs text-danger" role="alert">
                  {test.message}
                </p>
              ) : null
            }
          >
            <Button
              size="sm"
              variant="secondary"
              disabled={locked || test.kind === 'sending' || (!saved && !address.trim())}
              onClick={() => void sendTest()}
            >
              {test.kind === 'sending' ? 'Sending…' : 'Send a test'}
            </Button>
          </SettingsField>
        </>
      ) : null}
    </SettingsGroup>
  )
}
