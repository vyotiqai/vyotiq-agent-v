import { AlertBlock } from '@renderer/lib/ui'
import type { SettingsViewProps } from './types'
import { useSettingsForm } from './hooks/useSettingsForm'
import { SettingsLayout } from './components/SettingsLayout'
import { SettingsBackButton, SettingsNav } from './components/SettingsNav'
import { SettingsSectionHeader } from './components/SettingsSectionHeader'
import { SettingsSearch } from './components/SettingsSearch'
import { GeneralSection } from './sections/GeneralSection'
import { ProvidersSection } from './sections/ProvidersSection'
import { AgentSection } from './sections/AgentSection'
import { IndexingSection } from './sections/IndexingSection'
import { VoiceSection } from './sections/VoiceSection'
import { StorageSection } from './sections/StorageSection'
import { ToolsSection } from './sections/ToolsSection'
import { AboutSection } from './sections/AboutSection'
import { AppearanceSection } from './sections/AppearanceSection'
import { ShortcutsSection } from './sections/ShortcutsSection'

export function SettingsView(props: SettingsViewProps) {
  const {
    settings,
    secrets,
    backRef,
    onClose,
    onClearSecret,
    onAppearanceChange,
    onPickWorkspace,
    activeWorkspacePath = null,
    openWorkspaces = [],
    settingsOverridesByPath = {},
    onSetSettingsOverride,
    onOpenComposerModel
  } = props

  const form = useSettingsForm(props)

  const renderSection = () => {
    switch (form.section) {
      case 'general':
        return (
          <GeneralSection
            settings={settings}
            secrets={secrets}
            form={form}
            onPickWorkspace={onPickWorkspace}
            activeWorkspacePath={activeWorkspacePath}
            openWorkspaces={openWorkspaces}
            settingsOverridesByPath={settingsOverridesByPath}
            onSetSettingsOverride={onSetSettingsOverride}
            onOpenComposerModel={onOpenComposerModel}
            onOpenProviders={() => form.navigateSection('providers')}
          />
        )
      case 'appearance':
        return (
          <AppearanceSection
            settings={settings}
            form={form}
            onAppearanceChange={onAppearanceChange}
            customCssError={props.customCssError}
          />
        )
      case 'providers':
        return (
          <ProvidersSection
            settings={settings}
            secrets={secrets}
            secretsLoadError={props.secretsLoadError}
            form={form}
            onClearSecret={onClearSecret}
          />
        )
      case 'agent':
        return <AgentSection form={form} />
      case 'indexing':
        return <IndexingSection form={form} />
      case 'voice':
        return <VoiceSection form={form} secrets={secrets} />
      case 'storage':
        return <StorageSection form={form} />
      case 'tools':
        return <ToolsSection form={form} />
      case 'shortcuts':
        return <ShortcutsSection />
      case 'about':
        return <AboutSection form={form} />
      default: {
        const _exhaustive: never = form.section
        return _exhaustive
      }
    }
  }

  return (
    <SettingsLayout
      back={<SettingsBackButton backRef={backRef} onClose={onClose} />}
      search={
        <SettingsSearch
          section={form.section}
          onSectionChange={form.navigateSection}
          onRevealField={(id) => {
            if (id === 'custom-url') form.selectKeyProvider('custom')
            else if (id === 'ollama-url') form.selectKeyProvider('ollama')
          }}
          onClose={onClose}
        />
      }
      nav={<SettingsNav section={form.section} onSectionChange={form.navigateSection} />}
    >
      <SettingsSectionHeader section={form.section} />
      {renderSection()}
      {form.displayError && !form.errorField ? (
        <AlertBlock className="mt-3">{form.displayError}</AlertBlock>
      ) : null}
    </SettingsLayout>
  )
}
