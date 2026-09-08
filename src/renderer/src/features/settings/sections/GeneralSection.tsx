import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type DesktopNotificationMode,
  type NavigationMode,
  type SecretProvider,
  type Settings
} from '@shared/ipc'
import { findByWorkspacePath, workspacePathsEqual } from '@shared/workspacePathMatch'
import { Button, Input, Switch, Menu, cn } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { ActiveModelLink } from '../components/ActiveModelLink'
import { WorkspaceOverrideCard } from '../components/WorkspaceOverrideCard'
import { FeedbackDialog } from '@renderer/features/feedback'
import { NAVIGATION_MODE_OPTIONS } from '../constants'

export function GeneralSection({
  settings,
  secrets,
  form,
  onPickWorkspace,
  activeWorkspacePath,
  openWorkspaces,
  settingsOverridesByPath,
  onSetSettingsOverride,
  onOpenComposerModel,
  onOpenProviders
}: {
  settings: Settings
  secrets: Record<SecretProvider, boolean>
  form: SettingsFormState
  onPickWorkspace?: SettingsViewProps['onPickWorkspace']
  activeWorkspacePath: string | null
  openWorkspaces: string[]
  settingsOverridesByPath: SettingsViewProps['settingsOverridesByPath']
  onSetSettingsOverride?: SettingsViewProps['onSetSettingsOverride']
  onOpenComposerModel?: () => void
  onOpenProviders?: () => void
}) {
  const modelLabel = form.workspaceOverrideActive
    ? `${form.displayProviderMeta?.label ?? form.displayProvider} · ${form.displayModel} (workspace)`
    : `${form.displayProviderMeta?.label ?? form.displayProvider} · ${form.displayModel}`

  const persistedDiagnostics = form.settings.diagnosticsCommand ?? ''
  const [diagnosticsDraft, setDiagnosticsDraft] = useState(persistedDiagnostics)
  const [traceDumping, setTraceDumping] = useState(false)
  useEffect(() => {
    setDiagnosticsDraft(persistedDiagnostics)
  }, [persistedDiagnostics])

  const persistDiagnostics = (): void => {
    if (diagnosticsDraft === (form.settings.diagnosticsCommand ?? '')) return
    void form.runUpdate({ diagnosticsCommand: diagnosticsDraft })
  }
  const persistDiagnosticsRef = useRef(persistDiagnostics)
  persistDiagnosticsRef.current = persistDiagnostics
  useEffect(() => () => persistDiagnosticsRef.current(), [])

  const notifications = form.settings.notifications ?? DEFAULT_NOTIFICATION_SETTINGS
  const notificationsLocked = form.formLocked || !notifications.enabled
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const patchNotifications = (patch: Partial<typeof notifications>): void => {
    void form.runUpdate({ notifications: { ...notifications, ...patch } })
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Model">
        <SettingsField
          id="active-model"
          title="Active model"
          hint="Opens the composer model picker, or jump to Providers."
          help="Change provider in Providers; pick the model in the composer. Workspace Override can pin a different provider/model per folder."
        >
          <ActiveModelLink
            model={modelLabel}
            disabled={form.formLocked}
            onOpenComposer={onOpenComposerModel}
            onOpenProviders={onOpenProviders}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Editor">
        <SettingsField
          id="tab-autocomplete"
          title="Tab autocomplete"
          hint="Ghost text in the Files editor from the active model. Tab accepts, Esc dismisses. Typing the next characters keeps the rest."
          help="Uses the workspace-active provider and model. Requests fire after a short pause while typing. Turn off to stop those calls."
        >
          <Switch
            size="md"
            checked={form.settings.tabAutocomplete ?? true}
            disabled={form.formLocked}
            label="Tab autocomplete"
            onCheckedChange={(checked) => {
              void form.runUpdate({ tabAutocomplete: checked })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Navigation">
        <SettingsField
          id="navigation"
          title="Navigation"
          hint="Where sessions and workspaces live."
          help="Home page keeps sessions and workspaces on Home, with a slim sidebar. Sidebar is the classic layout. The sidebar layout applies immediately; the startup view changes the next time the app starts."
          wide
        >
          <div role="group" aria-label="Navigation" className="flex flex-wrap gap-2">
            {NAVIGATION_MODE_OPTIONS.map((option) => {
              const selected = form.settings.navigationMode === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={form.formLocked}
                  aria-pressed={selected}
                  onClick={() => {
                    if (form.settings.navigationMode !== option.value) {
                      void form.runUpdate({ navigationMode: option.value as NavigationMode })
                    }
                  }}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm vy-transition',
                    selected
                      ? 'border-fg bg-surface text-fg-strong ring-1 ring-inset ring-border-strong'
                      : 'border-border text-fg hover:bg-surface/50'
                  )}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Workspaces">
        <SettingsField
          id="workspaces"
          title="Workspaces"
          hint="Open workspace tabs. Enable Override for per-workspace provider, model, and agent settings."
          help="Override seeds thinking, compaction, and approval from global defaults when first enabled. Clear Override to return to app-wide settings."
          wide
        >
          {openWorkspaces.length === 0 ? (
            <p className="m-0 text-xs text-secondary">No workspaces open.</p>
          ) : (
            <div className="flex w-full flex-col gap-2">
              {openWorkspaces.map((path) => (
                <WorkspaceOverrideCard
                  key={path}
                  path={path}
                  isActive={
                    activeWorkspacePath !== null &&
                    workspacePathsEqual(path, activeWorkspacePath)
                  }
                  globalSettings={settings}
                  secrets={secrets}
                  override={
                    findByWorkspacePath(settingsOverridesByPath ?? {}, path) ?? undefined
                  }
                  disabled={form.formLocked || !onSetSettingsOverride}
                  onSetOverride={onSetSettingsOverride ?? (async () => ({ ok: true as const }))}
                  onOverrideError={(message) => form.setErrorMessage(message)}
                />
              ))}
            </div>
          )}
          {onPickWorkspace ? (
            <Button
              variant="subtle"
              pending={form.pickingWorkspace}
              disabled={form.formLocked}
              onClick={() => {
                form.clearErrors()
                form.setModelsInfo(null)
                form.setPickingWorkspace(true)
                void Promise.resolve(onPickWorkspace())
                  .catch((err: unknown) => {
                    form.setErrorMessage(err instanceof Error ? err.message : String(err))
                  })
                  .finally(() => form.setPickingWorkspace(false))
              }}
            >
              {form.pickingWorkspace ? 'Opening…' : 'Add workspace'}
            </Button>
          ) : null}
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Privacy">
        <SettingsField
          id="telemetry"
          title="Share crash & error reports"
          hint={
            form.dsnConfigured
              ? 'Optional opt-in. Local rotating logs are always written.'
              : 'Reporting unavailable in this build (no Sentry DSN).'
          }
          help="Never includes chat contents, API keys, or file bodies. Requires a build-time Sentry DSN."
        >
          <Switch
            size="md"
            checked={form.dsnConfigured && form.settings.telemetryEnabled}
            disabled={!form.dsnConfigured || form.formLocked}
            label="Share crash and error reports"
            onCheckedChange={(checked) => {
              void form.runUpdate({ telemetryEnabled: checked })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Notifications">
        <SettingsField
          id="notifications-enabled"
          title="Enable notifications"
          hint="Master switch for the inbox and desktop toasts."
          help="When off, nothing is stored in the inbox and no OS notifications are shown."
        >
          <Switch
            size="md"
            checked={notifications.enabled}
            disabled={form.formLocked}
            label="Enable notifications"
            onCheckedChange={(checked) => {
              patchNotifications({ enabled: checked })
            }}
          />
        </SettingsField>
        <SettingsField
          id="notifications-desktop"
          title="Desktop notifications"
          hint="When to show OS toasts. Inbox still records matching events."
          help="Unfocused shows a desktop toast only when the window is in the background or minimized."
        >
          <Menu
            aria-label="Desktop notifications"
            value={notifications.desktop}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'unfocused', label: 'When unfocused' },
              { value: 'always', label: 'Always' }
            ]}
            searchable={false}
            placement="down"
            disabled={notificationsLocked}
            onChange={(v) => {
              patchNotifications({ desktop: v as DesktopNotificationMode })
            }}
          />
        </SettingsField>
        <SettingsField
          id="notifications-run-finished"
          title="Agent run finished"
          hint="Inbox entry when a run completes."
        >
          <Switch
            size="md"
            checked={notifications.agentRunFinished}
            disabled={notificationsLocked}
            label="Agent run finished"
            onCheckedChange={(checked) => {
              patchNotifications({ agentRunFinished: checked })
            }}
          />
        </SettingsField>
        <SettingsField
          id="notifications-run-failed"
          title="Agent run failed"
          hint="Inbox entry when a run errors."
        >
          <Switch
            size="md"
            checked={notifications.agentRunFailed}
            disabled={notificationsLocked}
            label="Agent run failed"
            onCheckedChange={(checked) => {
              patchNotifications({ agentRunFailed: checked })
            }}
          />
        </SettingsField>
        <SettingsField
          id="notifications-needs-you"
          title="Agent needs you"
          hint="Approvals and questions waiting on you."
        >
          <Switch
            size="md"
            checked={notifications.agentNeedsYou}
            disabled={notificationsLocked}
            label="Agent needs you"
            onCheckedChange={(checked) => {
              patchNotifications({ agentNeedsYou: checked })
            }}
          />
        </SettingsField>
        <SettingsField
          id="notifications-system"
          title="System alerts"
          hint="Crash recovery and other system events."
        >
          <Switch
            size="md"
            checked={notifications.system}
            disabled={notificationsLocked}
            label="System alerts"
            onCheckedChange={(checked) => {
              patchNotifications({ system: checked })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Diagnostics">
        <SettingsField
          id="logs"
          title="Logs"
          hint={
            form.logsPath
              ? `Local rotating logs at ${form.logsPath}`
              : 'Open the local logs folder for troubleshooting.'
          }
          help="Always written locally regardless of telemetry. Useful when Crashpad dumps are empty."
        >
          <Button
            variant="subtle"
            pending={form.openingLogs}
            disabled={form.formLocked}
            onClick={() => {
              form.clearErrors()
              form.setOpeningLogs(true)
              void (window.vyotiq?.openLogsDir?.() ?? Promise.reject(new Error('Logs API unavailable')))
                .then((res) => {
                  if (!res.ok) form.setErrorMessage(res.error)
                })
                .catch((err: unknown) => {
                  form.setErrorMessage(err instanceof Error ? err.message : String(err))
                })
                .finally(() => form.setOpeningLogs(false))
            }}
          >
            {form.openingLogs ? 'Opening…' : 'Open logs folder'}
          </Button>
        </SettingsField>

        <SettingsField
          id="recent-crashes"
          title="Recent crashes"
          hint="Last renderer / GPU / utility process exits."
          help="Crashpad dumps are often empty for these exits — logs and this list are the useful signal."
          wide
        >
          {form.crashSnippets.length === 0 ? (
            <p className="m-0 text-xs text-secondary">No crashes recorded this install.</p>
          ) : (
            <ul className="m-0 flex max-h-40 list-none flex-col gap-1.5 overflow-auto p-0">
              {form.crashSnippets.map((snippet, i) => (
                <li
                  key={`${snippet.at}-${snippet.kind}-${i}`}
                  className="rounded-md border border-border/60 bg-bg px-2.5 py-1.5 text-caption text-secondary"
                >
                  <span className="font-medium text-fg">
                    {snippet.kind === 'renderer' ? 'Renderer' : 'Child'} · {snippet.reason}
                  </span>
                  <span className="mt-0.5 block text-muted">
                    {new Date(snippet.at).toLocaleString()}
                    {snippet.exitCodeHex
                      ? ` · ${snippet.exitCodeHex}`
                      : snippet.exitCode != null
                        ? ` · exit ${snippet.exitCode}`
                        : ''}
                    {snippet.processType ? ` · ${snippet.processType}` : ''}
                    {snippet.name ? ` · ${snippet.name}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SettingsField>

        <SettingsField
          id="trace-capture"
          title="Trace capture"
          hint="Traces record continuously in the background at near-zero cost and dump automatically on crashes or hangs."
          help="Always on. The button also dumps the last minutes of trace activity on demand; files land in the traces folder (chrome://tracing JSON)."
          wide
        >
          <Button
            variant="subtle"
            pending={traceDumping}
            disabled={form.formLocked}
            onClick={() => {
              form.clearErrors()
              setTraceDumping(true)
              void (window.vyotiq?.stopTrace?.() ?? Promise.reject(new Error('Trace API unavailable')))
                .then((res) => {
                  if (res.ok) window.vyotiq?.openLogsDir?.()
                  else form.setErrorMessage(res.error)
                })
                .catch((err: unknown) => {
                  form.setErrorMessage(err instanceof Error ? err.message : String(err))
                })
                .finally(() => setTraceDumping(false))
            }}
          >
            {traceDumping ? 'Dumping…' : 'Dump trace now'}
          </Button>
        </SettingsField>

        <SettingsField
          id="diagnostics-command"
          title="Diagnostics command"
          hint="Optional override for the diagnostics tool typecheck."
          help="Leave blank to auto-detect (package scripts or tsc)."
          wide
        >
          <Input
            className="w-full"
            placeholder="e.g. pnpm typecheck"
            aria-label="Diagnostics command"
            disabled={form.formLocked}
            value={diagnosticsDraft}
            onChange={(e) => {
              setDiagnosticsDraft(e.target.value)
            }}
            onBlur={() => {
              persistDiagnostics()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Feedback">
        <SettingsField
          id="send-feedback"
          title="Send feedback"
          hint="Report a bug, request a feature, or share praise. Opens a pre-filled email to vyotiq@gmail.com."
          help="Feedback goes straight to the team's inbox. Optional diagnostics add app version, OS, and locale only — never chat contents."
        >
          <Button variant="subtle" onClick={() => setFeedbackOpen(true)}>
            Send feedback
          </Button>
        </SettingsField>
      </SettingsGroup>

      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </SettingsStack>
  )
}
