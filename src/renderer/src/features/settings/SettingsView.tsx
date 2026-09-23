import { useState } from 'react'
import { Alert } from '@renderer/lib/ui'
import { FeedbackDialog } from '@renderer/features/feedback'
import type { SettingsViewProps } from './types'
import { useSettingsForm } from './hooks/useSettingsForm'
import { SettingsLayout } from './components/SettingsLayout'
import { SettingsBackButton, SettingsNav } from './components/SettingsNav'
import { SettingsSectionHeader } from './components/SettingsSectionHeader'
import { SettingsSearch } from './components/SettingsSearch'
import { GeneralSection } from './sections/GeneralSection'
import { AppearanceSection } from './sections/AppearanceSection'
import { NotificationsSection } from './sections/NotificationsSection'
import { ShortcutsSection } from './sections/ShortcutsSection'
import { ProvidersSection } from './sections/ProvidersSection'
import { AgentSection } from './sections/AgentSection'
import { ToolsSection } from './sections/ToolsSection'
import { IndexingSection } from './sections/IndexingSection'
import { VoiceSection } from './sections/VoiceSection'
import { StorageSection } from './sections/StorageSection'
import { DiagnosticsSection } from './sections/DiagnosticsSection'
import { AboutSection } from './sections/AboutSection'

export function SettingsView(props: SettingsViewProps) {
  const {
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
    onOpenComposerModel,
    onOpenMarketplace
  } = props

  const form = useSettingsForm(props)

  // The dialog lives here, not in a section, so the command palette can open
  // it over whichever section is showing. App lifts the state for that path;
  // the local copy covers a standalone render.
  const [localFeedbackOpen, setLocalFeedbackOpen] = useState(false)
  const feedbackOpen = props.feedbackOpen ?? localFeedbackOpen
  const setFeedbackOpen = (open: boolean): void => {
    setLocalFeedbackOpen(open)
    props.onFeedbackOpenChange?.(open)
  }

  const renderSection = () => {
    switch (form.section) {
      case 'general':
        return (
          <GeneralSection
            secrets={secrets}
            form={form}
            onPickWorkspace={onPickWorkspace}
            activeWorkspacePath={activeWorkspacePath}
            openWorkspaces={openWorkspaces}
            settingsOverridesByPath={settingsOverridesByPath}
            onSetSettingsOverride={onSetSettingsOverride}
          />
        )
      case 'appearance':
        return (
          <AppearanceSection
            form={form}
            onAppearanceChange={onAppearanceChange}
            customCssError={props.customCssError}
          />
        )
      case 'notifications':
        return <NotificationsSection form={form} />
      case 'shortcuts':
        return <ShortcutsSection />
      case 'providers':
        return (
          <ProvidersSection
            secrets={secrets}
            secretsLoadError={props.secretsLoadError}
            form={form}
            onClearSecret={onClearSecret}
            onOpenComposerModel={onOpenComposerModel}
          />
        )
      case 'agent':
        return <AgentSection form={form} onOpenMarketplace={onOpenMarketplace} />
      case 'tools':
        return <ToolsSection form={form} onOpenMarketplace={onOpenMarketplace} />
      case 'indexing':
        return <IndexingSection form={form} />
      case 'voice':
        return <VoiceSection form={form} secrets={secrets} />
      case 'storage':
        return <StorageSection form={form} />
      case 'diagnostics':
        return <DiagnosticsSection form={form} />
      case 'about':
        return <AboutSection form={form} onOpenFeedback={() => setFeedbackOpen(true)} />
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
      {/* Under the title and pinned while scrolling: a failed save several
          screens down a long section used to report at the very bottom of the
          page, where nobody was looking. */}
      {form.displayError && !form.errorField ? (
        <div className="sticky top-0 z-sticky mb-4 bg-bg">
          <Alert onDismiss={form.clearErrors}>{form.displayError}</Alert>
        </div>
      ) : null}
      {renderSection()}
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </SettingsLayout>
  )
}
