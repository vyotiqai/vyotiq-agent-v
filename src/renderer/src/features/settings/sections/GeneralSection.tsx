import { useEffect, useState } from 'react'
import type { PreferredEditor, SecretProvider } from '@shared/ipc'
import { editorName } from '@renderer/lib/openInEditor'
import { Button } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { LAUNCH_VIEW_OPTIONS, MAX_CHAT_PANE_OPTIONS } from '../constants'
import { SegmentedField } from '../components/SegmentedField'
import { SelectField } from '../components/SelectField'
import { SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'
import { WorkspaceOverrideList } from '../components/WorkspaceOverrideList'
import { NetworkGroup } from '../components/NetworkGroup'
import { CommandLineGroup } from '../components/CommandLineGroup'

export function GeneralSection({
  secrets,
  form,
  onPickWorkspace,
  activeWorkspacePath,
  openWorkspaces,
  settingsOverridesByPath,
  onSetSettingsOverride
}: {
  secrets: Record<SecretProvider, boolean>
  form: SettingsFormState
  onPickWorkspace?: SettingsViewProps['onPickWorkspace']
  activeWorkspacePath: string | null
  openWorkspaces: string[]
  settingsOverridesByPath: SettingsViewProps['settingsOverridesByPath']
  onSetSettingsOverride?: SettingsViewProps['onSetSettingsOverride']
}) {
  const settings = form.settings
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  // Editors whose command is on PATH, so the menu says which ones will work.
  const [installedEditors, setInstalledEditors] = useState<string[] | null>(null)
  useEffect(() => {
    void window.vyotiq?.editorList?.().then((res) => setInstalledEditors(res?.ok ? res.data : []))
  }, [])
  const editorOptions = EDITOR_CHOICES.map((id) => ({
    value: id,
    label:
      id === 'auto'
        ? installedEditors?.[0]
          ? `Auto (${editorName(installedEditors[0])})`
          : 'Auto'
        : id === 'system'
          ? 'The default app for the file'
          : installedEditors && !installedEditors.includes(id)
            ? `${editorName(id)} (not found)`
            : editorName(id)
  }))

  const addWorkspace = (): void => {
    if (!onPickWorkspace) return
    form.clearErrors()
    setPickingWorkspace(true)
    void Promise.resolve(onPickWorkspace())
      .catch((err: unknown) => {
        form.setErrorMessage(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setPickingWorkspace(false))
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Start">
        <SegmentedField
          id="navigation"
          title="Open on launch"
          hint="Where the window lands when Agent V starts."
          value={settings.navigationMode}
          options={LAUNCH_VIEW_OPTIONS}
          disabled={form.formLocked}
          onChange={(navigationMode) => {
            void form.runUpdate({ navigationMode })
          }}
          {...form.defaultMark('navigationMode')}
        />
        <SelectField
          id="max-chat-panes"
          title="Tasks side by side"
          hint="How many tasks fit next to each other. Auto fits the window, up to 6."
          help="Auto fits as many 280px columns as the window allows. A fixed number can be more than fits; the row of tasks then scrolls."
          value={String(settings.maxChatPanes ?? 0)}
          options={MAX_CHAT_PANE_OPTIONS}
          width={150}
          disabled={form.formLocked}
          onChange={(value) => {
            void form.runUpdate({ maxChatPanes: Number(value) })
          }}
          {...form.defaultMark('maxChatPanes')}
        />
      </SettingsGroup>

      <SettingsGroup title="Editor">
        <SelectField
          id="preferred-editor"
          title="Open files in"
          hint="Where Open in editor goes: from the Files and Changes tabs, a task’s menu, and Ctrl+click on a file in an answer."
          value={settings.preferredEditor ?? 'auto'}
          options={editorOptions}
          width={220}
          disabled={form.formLocked}
          onChange={(preferredEditor) => {
            void form.runUpdate({ preferredEditor })
          }}
          {...form.defaultMark('preferredEditor')}
        />
      </SettingsGroup>

      <SettingsGroup title="Closing">
        {window.vyotiq?.platform !== 'darwin' ? (
          <SwitchField
            id="close-to-tray"
            title="Keep running in the tray"
            hint="Closing the window hides it; tasks, loops and scheduled tasks keep going. Quit from the tray icon."
            checked={settings.closeToTray ?? false}
            disabled={form.formLocked}
            onChange={(closeToTray) => {
              void form.runUpdate({ closeToTray })
            }}
            {...form.defaultMark('closeToTray')}
          />
        ) : null}
        <SwitchField
          id="confirm-quit-running"
          title="Ask before quitting with tasks running"
          hint="Quitting stops running tasks; loops and scheduled tasks wait until Agent V is open again."
          checked={settings.confirmQuitWithRunningTasks ?? true}
          disabled={form.formLocked}
          onChange={(confirmQuitWithRunningTasks) => {
            void form.runUpdate({ confirmQuitWithRunningTasks })
          }}
          {...form.defaultMark('confirmQuitWithRunningTasks')}
        />
      </SettingsGroup>

      {window.vyotiq?.platform === 'win32' ? (
        <CommandLineGroup disabled={form.formLocked} onError={form.setErrorMessage} />
      ) : null}

      <SettingsGroup
        title="Workspaces"
        description="Override gives a workspace its own model and agent settings."
        fieldId="workspaces"
      >
        <WorkspaceOverrideList
          paths={openWorkspaces}
          activePath={activeWorkspacePath}
          globalSettings={settings}
          secrets={secrets}
          overridesByPath={settingsOverridesByPath ?? {}}
          disabled={form.formLocked || !onSetSettingsOverride}
          onSetOverride={onSetSettingsOverride ?? (async () => ({ ok: true as const }))}
          onError={form.setErrorMessage}
        />
      </SettingsGroup>
      {onPickWorkspace ? (
        <div className="pt-2">
          <Button
            size="xs"
            variant="ghost"
            icon="plus"
            pending={pickingWorkspace}
            disabled={form.formLocked}
            onClick={addWorkspace}
          >
            {pickingWorkspace ? 'Opening…' : 'Add workspace'}
          </Button>
        </div>
      ) : null}

      <NetworkGroup form={form} />
    </SettingsStack>
  )
}

const EDITOR_CHOICES: readonly PreferredEditor[] = [
  'auto',
  'vscode',
  'cursor',
  'windsurf',
  'zed',
  'sublime',
  'webstorm',
  'idea',
  'pycharm',
  'system'
]
