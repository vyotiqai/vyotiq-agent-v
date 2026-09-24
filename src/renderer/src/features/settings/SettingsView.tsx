import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { providerLabel } from '@shared/providers'
import { useNavigatorSlot } from '@renderer/lib/context/NavigatorSlot'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { isEditableShortcutTarget } from '@renderer/lib/shortcuts/match'
import { Alert, Button, FormChangesContext, type FormChange } from '@renderer/lib/ui'
import { FeedbackDialog } from '@renderer/features/feedback'
import type { SettingsSection, SettingsViewProps } from './types'
import { useSettingsForm, type SettingReset } from './hooks/useSettingsForm'
import { SECTION_DESCRIPTIONS, SECTION_LABELS } from './constants'
import { SettingsIndex, SettingsIndexStrip, type SettingsIssues } from './components/SettingsNav'
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

function isSettingReset(token: unknown): token is SettingReset {
  return typeof token === 'object' && token !== null && 'scope' in token && 'key' in token
}

/**
 * The rows changed from their default in the section on screen. Rows report
 * themselves (`FormRow`), so the count can never disagree with the marks.
 */
function useChangedRows() {
  const rows = useRef(new Map<string, () => FormChange>())
  const [count, setCount] = useState(0)
  const registry = useMemo(
    () => ({
      report: (id: string, read: (() => FormChange) | null) => {
        if (read) rows.current.set(id, read)
        else rows.current.delete(id)
        setCount(rows.current.size)
      }
    }),
    []
  )
  return { registry, count, read: () => [...rows.current.values()].map((row) => row()) }
}

function sectionDescription(section: SettingsSection): string {
  if (section === 'shortcuts') {
    const search = shortcutLabel('search').split('+').join(' ')
    return `Every command is also in ${search} — shortcuts are only the fast path.`
  }
  return SECTION_DESCRIPTIONS[section]
}

/**
 * Settings: its own index in the navigator's column (see NavigatorSlot), and
 * the section beside it. The header says how many rows are set away from
 * their default and resets them together; every control shows its value, but
 * only those rows carry a mark, so defaults read quiet.
 */
export function SettingsView(props: SettingsViewProps) {
  const {
    secrets,
    backRef,
    backLabel = 'Back',
    onClose,
    onClearSecret,
    onAppearanceChange,
    onPickWorkspace,
    activeWorkspacePath = null,
    openWorkspaces = [],
    settingsOverridesByPath = {},
    onSetSettingsOverride,
    onOpenMarketplace
  } = props

  const form = useSettingsForm(props)
  const slot = useNavigatorSlot()
  const changes = useChangedRows()
  const searchRef = useRef<HTMLInputElement>(null)

  // The dialog lives here, not in a section, so the command palette can open
  // it over whichever section is showing. App lifts the state for that path;
  // the local copy covers a standalone render.
  const [localFeedbackOpen, setLocalFeedbackOpen] = useState(false)
  const feedbackOpen = props.feedbackOpen ?? localFeedbackOpen
  const setFeedbackOpen = (open: boolean): void => {
    setLocalFeedbackOpen(open)
    props.onFeedbackOpenChange?.(open)
  }

  // `/` goes to search, as its keycap says — unless something is being typed.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
      if (isEditableShortcutTarget(e.target)) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const issues: SettingsIssues = form.activeNeedsKey
    ? { providers: `${providerLabel(form.settings.provider)} has no API key` }
    : {}

  const resetSection = (): void => {
    const rows = changes.read()
    const merged = rows.map((row) => row.token).filter(isSettingReset)
    if (merged.length > 0) form.resetToDefaults(merged)
    for (const row of rows) {
      if (!isSettingReset(row.token)) row.reset?.()
    }
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
            settingsOverridesByPath={settingsOverridesByPath}
          />
        )
      case 'agent':
        return <AgentSection form={form} onOpenMarketplace={onOpenMarketplace} />
      case 'tools':
        return <ToolsSection form={form} onOpenMarketplace={onOpenMarketplace} />
      case 'indexing':
        return <IndexingSection form={form} openWorkspaces={openWorkspaces} />
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

  const search = (
    <SettingsSearch
      inputRef={searchRef}
      section={form.section}
      onSectionChange={form.navigateSection}
      onRevealField={(id) => {
        if (id === 'custom-url') form.selectKeyProvider('custom')
        else if (id === 'ollama-url') form.selectKeyProvider('ollama')
      }}
      onClose={onClose}
    />
  )
  const indexProps = {
    section: form.section,
    onSectionChange: form.navigateSection,
    backLabel,
    backRef,
    onBack: onClose,
    issues,
    search
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-settings-shell>
      {slot ? createPortal(<SettingsIndex {...indexProps} />, slot) : <SettingsIndexStrip {...indexProps} />}
      <header
        className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border pl-4 pr-2"
        data-settings-header
      >
        <h1 className="m-0 shrink-0 text-sm font-semibold text-fg-strong">{SECTION_LABELS[form.section]}</h1>
        <p className="m-0 min-w-0 truncate text-xs text-tertiary">{sectionDescription(form.section)}</p>
        <span className="flex-1" />
        {changes.count > 0 ? (
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted" data-settings-changed>
            <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
            {changes.count} changed from default
            <Button size="xs" variant="ghost" disabled={form.formLocked} onClick={resetSection}>
              Reset section
            </Button>
          </span>
        ) : null}
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-settings-content>
        <div className="w-full max-w-[800px] px-5 pb-16 pt-2 sm:px-10">
          {/* Pinned while scrolling: a failed save several screens down a long
              section used to report at the very bottom of the page, where
              nobody was looking. */}
          {form.displayError && !form.errorField ? (
            <div className="sticky top-0 z-sticky bg-bg pt-4">
              <Alert onDismiss={form.clearErrors}>{form.displayError}</Alert>
            </div>
          ) : null}
          <FormChangesContext.Provider value={changes.registry}>{renderSection()}</FormChangesContext.Provider>
        </div>
      </div>
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  )
}
