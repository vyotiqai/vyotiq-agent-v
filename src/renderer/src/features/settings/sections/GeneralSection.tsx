import { useState } from 'react'
import type { NavigationMode, SecretProvider } from '@shared/ipc'
import { Button } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { MAX_CHAT_PANE_OPTIONS, NAVIGATION_MODE_OPTIONS } from '../constants'
import { ChoiceCards } from '../components/ChoiceCards'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
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
      <SettingsGroup title="Layout">
        <SettingsField
          id="navigation"
          title="Navigation"
          hint="Where sessions and workspaces live."
          help="The sidebar changes right away; the startup view follows the next time the app starts."
          wide
        >
          <ChoiceCards
            label="Navigation"
            value={settings.navigationMode}
            options={NAVIGATION_MODE_OPTIONS}
            disabled={form.formLocked}
            onChange={(value) => {
              void form.runUpdate({ navigationMode: value as NavigationMode })
            }}
          />
        </SettingsField>
        <SelectField
          id="max-chat-panes"
          title="Max chat panes"
          hint="Sessions shown side by side."
          help="Auto fits as many 280px columns as the window allows, up to 6. A fixed number can exceed what fits; the pane row then scrolls."
          value={String(settings.maxChatPanes ?? 0)}
          options={MAX_CHAT_PANE_OPTIONS}
          disabled={form.formLocked}
          onChange={(value) => {
            void form.runUpdate({ maxChatPanes: Number(value) })
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Workspaces">
        <SettingsField
          id="workspaces"
          title="Open workspaces"
          hint="Override gives a workspace its own model and agent settings."
          help="Turning Override on starts the workspace from your current settings. While it is on for the active workspace, rows marked Workspace in Providers and Agent save to that workspace only. Turn it off to go back to app-wide settings."
          wide
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
            action={
              onPickWorkspace ? (
                <Button
                  variant="subtle"
                  pending={pickingWorkspace}
                  disabled={form.formLocked}
                  onClick={addWorkspace}
                >
                  {pickingWorkspace ? 'Opening…' : 'Add workspace'}
                </Button>
              ) : undefined
            }
          />
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
