import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigatorSlot } from '@renderer/lib/context/NavigatorSlot'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { isEditableShortcutTarget } from '@renderer/lib/shortcuts/match'
import { Alert, Button, FormChangesContext, type FormChange } from '@renderer/lib/ui'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'
import { FeedbackDialog } from '@renderer/features/feedback'
import type { SettingsSection, SettingsViewProps } from './types'
import { useSettingsForm, type SettingReset } from './hooks/useSettingsForm'
import { SECTION_ANCHOR_ATTRIBUTE, useSectionScroll } from './hooks/useSectionScroll'
import { SECTION_DESCRIPTIONS, SECTION_GROUPS, SECTION_LABELS } from './constants'
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

/** Every section, top to bottom of the column — the index's order. */
const SECTION_ORDER: readonly SettingsSection[] = SECTION_GROUPS.flatMap((group) => group.sections)

type ChangesRegistry = { report: (id: string, read: (() => FormChange) | null) => void }

/**
 * The rows changed from their default, per section, so the header can count
 * and reset the section in view. Rows report themselves (`FormRow`), so the
 * count can never disagree with the marks.
 */
function useChangedRows() {
  const rows = useRef(new Map<SettingsSection, Map<string, () => FormChange>>())
  const [counts, setCounts] = useState<Partial<Record<SettingsSection, number>>>({})
  const registries = useMemo(
    () =>
      Object.fromEntries(
        SECTION_ORDER.map((section): [SettingsSection, ChangesRegistry] => [
          section,
          {
            report: (id, read) => {
              let map = rows.current.get(section)
              if (!map) {
                map = new Map()
                rows.current.set(section, map)
              }
              if (read) map.set(id, read)
              else map.delete(id)
              const size = map.size
              setCounts((prev) => (prev[section] === size ? prev : { ...prev, [section]: size }))
            }
          }
        ])
      ) as Record<SettingsSection, ChangesRegistry>,
    []
  )
  return {
    registries,
    count: (section: SettingsSection) => counts[section] ?? 0,
    read: (section: SettingsSection) => [...(rows.current.get(section)?.values() ?? [])].map((row) => row())
  }
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
 * every section beside it in one scrolling column. The index is the column's
 * table of contents and marks the section in view; the header follows that
 * section, says how many of its rows are set away from their default and
 * resets them together. Every control shows its value, but only those rows
 * carry a mark, so defaults read quiet.
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
  const scroll = useSectionScroll(form.section, form.setSection)
  const section = scroll.active
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
    ? { providers: `${form.providerDisplayLabel} has no API key` }
    : {}

  const resetSection = (): void => {
    const rows = changes.read(section)
    const merged = rows.map((row) => row.token).filter(isSettingReset)
    if (merged.length > 0) form.resetToDefaults(merged)
    for (const row of rows) {
      if (!isSettingReset(row.token)) row.reset?.()
    }
  }

  // The index jumps the column; like a page change used to, it drops a
  // message about a save elsewhere.
  const goToSection = (id: SettingsSection): void => {
    scroll.goTo(id)
    form.navigateSection(id)
  }

  const renderSection = (id: SettingsSection) => {
    switch (id) {
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
        return <ShortcutsSection form={form} />
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
        return <AgentSection form={form} secrets={secrets} onOpenMarketplace={onOpenMarketplace} />
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
        const _exhaustive: never = id
        return _exhaustive
      }
    }
  }

  const search = (
    <SettingsSearch
      inputRef={searchRef}
      onSectionChange={goToSection}
      onRevealField={(id) => {
        if (id === 'custom-url') form.selectKeyProvider('custom')
        else if (id === 'ollama-url') form.selectKeyProvider('ollama')
      }}
      onClose={onClose}
    />
  )
  const indexProps = {
    section,
    onSectionChange: goToSection,
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
        <h1 className="m-0 shrink-0 text-sm font-semibold text-fg-strong">{SECTION_LABELS[section]}</h1>
        <p className="m-0 min-w-0 truncate text-xs text-tertiary">{sectionDescription(section)}</p>
        <span className="flex-1" />
        {changes.count(section) > 0 ? (
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted" data-settings-changed>
            <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
            {changes.count(section)} changed from default
            <Button size="xs" variant="ghost" disabled={form.formLocked} onClick={resetSection}>
              Reset section
            </Button>
          </span>
        ) : null}
      </header>
      <div
        ref={scroll.scrollerRef}
        onScroll={scroll.onScroll}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto"
        data-settings-content
      >
        {/* The bottom gap lets the last, short sections still reach the top. */}
        <div ref={scroll.contentRef} className="w-full max-w-[800px] px-5 pb-[40vh] pt-2 sm:px-10">
          {/* Pinned while scrolling: a failed save several screens down the
              column would otherwise report where nobody is looking. */}
          {form.displayError && !form.errorField ? (
            <div className="sticky top-0 z-sticky bg-bg pt-4">
              <Alert onDismiss={form.clearErrors}>{form.displayError}</Alert>
            </div>
          ) : null}
          {SECTION_ORDER.map((id) => (
            <section
              key={id}
              {...{ [SECTION_ANCHOR_ATTRIBUTE]: id }}
              aria-labelledby={`settings-section-${id}`}
              className="pt-12 first-of-type:pt-4"
            >
              <h2 id={`settings-section-${id}`} className="m-0 text-md font-semibold text-fg-strong">
                {SECTION_LABELS[id]}
              </h2>
              {scroll.mounted.has(id) ? (
                // One section failing keeps the rest of the column working.
                <ErrorBoundary panel={SECTION_LABELS[id]}>
                  <FormChangesContext.Provider value={changes.registries[id]}>
                    {renderSection(id)}
                  </FormChangesContext.Provider>
                </ErrorBoundary>
              ) : (
                // Holds the section's place until it nears the visible column.
                <div aria-hidden="true" className="h-[60vh]" data-settings-placeholder />
              )}
            </section>
          ))}
        </div>
      </div>
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  )
}
