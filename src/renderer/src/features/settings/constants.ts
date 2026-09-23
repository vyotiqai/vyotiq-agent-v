import type { FontScale, UiDensity } from '@shared/appearance'
import type {
  AutonomousSkipQuestions,
  DesktopNotificationMode,
  DictationEngine,
  DictationWaveformStyle,
  ResponseVerbosity,
  SearchEngineId,
  TerminalShell,
  ThemeId,
  ToolApprovalMode
} from '@shared/ipc'
import type { IconName } from '@renderer/lib/icons'
import type { ChoiceCardOption } from './components/ChoiceCards'
import type { SettingsErrorField, SettingsOption, SettingsSection } from './types'

export const THEME_OPTIONS: SettingsOption<ThemeId>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

export const FONT_SCALE_OPTIONS: SettingsOption<FontScale>[] = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' }
]

export const DENSITY_OPTIONS: SettingsOption<UiDensity>[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'default', label: 'Default' },
  { value: 'comfortable', label: 'Comfortable' }
]

export const NAVIGATION_MODE_OPTIONS: ChoiceCardOption[] = [
  {
    value: 'home',
    label: 'Home page',
    description: 'Sessions and workspaces on Home, slim sidebar'
  },
  {
    value: 'sidebar',
    label: 'Sidebar',
    description: 'Sessions and workspaces listed in the sidebar'
  }
]

/** `maxChatPanes` is numeric in settings; the menu speaks strings. 0 = Auto. */
export const MAX_CHAT_PANE_OPTIONS: SettingsOption[] = [
  { value: '0', label: 'Auto (fits window)' },
  ...['1', '2', '3', '4', '5', '6'].map((value) => ({ value, label: value }))
]

export const DESKTOP_NOTIFICATION_OPTIONS: SettingsOption<DesktopNotificationMode>[] = [
  { value: 'off', label: 'Off' },
  { value: 'unfocused', label: 'When in background' },
  { value: 'always', label: 'Always' }
]

export const TOOL_APPROVAL_OPTIONS: SettingsOption<ToolApprovalMode>[] = [
  { value: 'off', label: 'Off' },
  { value: 'mutating', label: 'Ask for edits and commands' },
  { value: 'all', label: 'Ask for every tool' }
]

export const AUTONOMOUS_QUESTIONS_OPTIONS: SettingsOption<AutonomousSkipQuestions>[] = [
  { value: 'wait', label: 'Wait for an answer' },
  { value: 'skip', label: 'Skip the question' }
]

export const RESPONSE_VERBOSITY_OPTIONS: SettingsOption<ResponseVerbosity>[] = [
  { value: 'concise', label: 'Concise' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'detailed', label: 'Detailed' }
]

export const TERMINAL_SHELL_OPTIONS: SettingsOption<TerminalShell>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'cmd', label: 'cmd.exe' },
  { value: 'bash', label: 'Bash' }
]

export const TERMINAL_SCREEN_READER_OPTIONS: SettingsOption<'auto' | 'on' | 'off'>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'Always on' },
  { value: 'off', label: 'Off' }
]

export const SEARCH_ENGINE_OPTIONS: SettingsOption<SearchEngineId>[] = [
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'bing', label: 'Bing' },
  { value: 'google', label: 'Google' }
]

export const DICTATION_ENGINE_OPTIONS: SettingsOption<DictationEngine>[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'local', label: 'Local' }
]

export const DICTATION_WAVEFORM_STYLE_OPTIONS: SettingsOption<DictationWaveformStyle>[] = [
  { value: 'bars', label: 'Bars' },
  { value: 'dots', label: 'Dots' },
  { value: 'line', label: 'Line' },
  { value: 'mirror', label: 'Mirror' }
]

/** Mirrors the zod maxes in shared/ipc/schemas/settings.ts. */
export const PERSONA_MAX_LENGTH = 1000
export const TONE_MAX_LENGTH = 2000
export const IDENTITY_MAX_LENGTH = 1000
export const LANGUAGE_MAX_LENGTH = 64

export const RESPONSE_LANGUAGE_SUGGESTIONS = [
  'English',
  'Spanish',
  'French',
  'German',
  'Portuguese',
  'Italian',
  'Dutch',
  'Russian',
  'Ukrainian',
  'Polish',
  'Turkish',
  'Arabic',
  'Hindi',
  'Chinese',
  'Japanese',
  'Korean'
]

export const SECTION_LABELS: Record<SettingsSection, string> = {
  general: 'General',
  appearance: 'Appearance',
  notifications: 'Notifications',
  shortcuts: 'Shortcuts',
  providers: 'Providers',
  agent: 'Agent',
  tools: 'Tools',
  indexing: 'Indexing',
  voice: 'Voice',
  storage: 'Storage',
  diagnostics: 'Diagnostics',
  about: 'About'
}

export const SECTION_ICONS: Record<SettingsSection, IconName> = {
  general: 'gear',
  appearance: 'sliders',
  notifications: 'bell',
  shortcuts: 'keyboard',
  providers: 'mcp',
  agent: 'bot',
  tools: 'plug',
  indexing: 'fileSearch',
  voice: 'mic',
  storage: 'stack',
  diagnostics: 'pulse',
  about: 'info'
}

/**
 * Nav order and grouping. Twelve flat entries read as one undifferentiated
 * column; three headings let the eye jump to the right third first. Inside a
 * group, the order is the order the questions get asked — which model before
 * how it behaves, what it may run before how its tools are set up.
 */
export const SECTION_GROUPS: readonly {
  label: string
  sections: readonly SettingsSection[]
}[] = [
  { label: 'App', sections: ['general', 'appearance', 'notifications', 'shortcuts'] },
  { label: 'Agent', sections: ['providers', 'agent', 'tools', 'indexing', 'voice'] },
  { label: 'System', sections: ['storage', 'diagnostics', 'about'] }
]

/**
 * DOM ids for the inline error under a field, referenced by that control's
 * `aria-describedby`. Keyed by {@link SettingsErrorField} so adding a field
 * without an id is a type error rather than a silently unlabelled input.
 */
export const SETTINGS_ERROR_IDS: Record<Exclude<SettingsErrorField, null>, string> = {
  ollama: 'ollama-error',
  customUrl: 'custom-url-error',
  apikey: 'apikey-error',
  keepTurns: 'keep-turns-error',
  autoCompactThreshold: 'auto-compact-threshold-error',
  checkpointKeep: 'checkpoint-keep-error',
  checkpointAge: 'checkpoint-age-error',
  orphanGrace: 'orphan-grace-error',
  sessionKeep: 'session-keep-error',
  sessionAge: 'session-age-error',
  sizeCap: 'size-cap-error'
}
