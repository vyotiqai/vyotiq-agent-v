import { useState } from 'react'
import type { SecretProvider } from '@shared/ipc'
import { Button } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { LAUNCH_VIEW_OPTIONS, MAX_CHAT_PANE_OPTIONS } from '../constants'
import { SegmentedField } from '../components/SegmentedField'
import { SelectField } from '../components/SelectField'
import { SettingsGroup, SettingsStack } from '../components/SettingsField'
import { WorkspaceOverrideList } from '../components/WorkspaceOverrideList'

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
    </SettingsStack>
  )
}
