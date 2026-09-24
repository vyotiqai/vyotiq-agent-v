import type { FontScale, UiDensity } from '@shared/appearance'
import type {
  AutonomousSkipQuestions,
  DesktopNotificationMode,
  DictationEngine,
  DictationWaveformStyle,
  NavigationMode,
  ProviderId,
  ResponseVerbosity,
  SecretProvider,
  SearchEngineId,
  TerminalShell,
  ThemeId,
  ToolApprovalMode
} from '@shared/ipc'
import type { IconName } from '@renderer/lib/icons'
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

/**
 * Where the window lands at start. `navigationMode` is the setting's old name
 * from when it also chose the sidebar's layout; today it only picks the view
 * the app opens on — Home, or the task view with the last open task.
 */
export const LAUNCH_VIEW_OPTIONS: SettingsOption<NavigationMode>[] = [
  { value: 'home', label: 'Home' },
  { value: 'sidebar', label: 'Last task' }
]

/** `maxChatPanes` is numeric in settings; the menu speaks strings. 0 = Auto. */
export const MAX_CHAT_PANE_OPTIONS: SettingsOption[] = [
  { value: '0', label: 'Auto — fits the window' },
  ...['1', '2', '3', '4', '5', '6'].map((value) => ({ value, label: value }))
]

export const DESKTOP_NOTIFICATION_OPTIONS: SettingsOption<DesktopNotificationMode>[] = [
  { value: 'off', label: 'Off' },
  { value: 'unfocused', label: 'When in background' },
  { value: 'always', label: 'Always' }
]

/** Read as "Ask before …". */
export const TOOL_APPROVAL_OPTIONS: SettingsOption<ToolApprovalMode>[] = [
  { value: 'off', label: 'Nothing' },
  { value: 'mutating', label: 'Edits and commands' },
  { value: 'all', label: 'Every tool' }
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
  appearance: 'circleHalf',
  notifications: 'bell',
  shortcuts: 'keyboard',
  providers: 'cpu',
  agent: 'robot',
  tools: 'tool',
  indexing: 'database',
  voice: 'mic',
  storage: 'stack',
  diagnostics: 'pulse',
  about: 'info'
}

/**
 * One line beside the section's name in its header: what the section is for,
 * so the rows under it need no preamble. Shortcuts names the search chord at
 * render time, since it differs by platform.
 */
export const SECTION_DESCRIPTIONS: Record<Exclude<SettingsSection, 'shortcuts'>, string> = {
  general: 'Where Agent V opens, and the workspaces it knows.',
  appearance: 'Skin, colour mode, type size and density. Changes apply as you pick.',
  notifications: 'What reaches the inbox, and what reaches the desktop.',
  providers: 'Model providers and their keys. Keys are encrypted on this device and sent only to their provider.',
  agent: 'What the agent may do without asking, and how its record reads.',
  tools: 'Terminal, browser and MCP behaviour, and the live tool catalog.',
  indexing: 'The codebase index behind search and concept lookups.',
  voice: 'Dictation for instructions and briefs.',
  storage: 'What Agent V keeps on disk, and when it lets go of it.',
  diagnostics: 'Logs, traces and crash reports — local unless you share them.',
  about: 'Version, updates and feedback.'
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

/**
 * Providers in the order the API keys list shows them: the subscription
 * first, then the labs, the local daemon, the gateways, and custom last.
 */
export const PROVIDER_KEY_ORDER: readonly ProviderId[] = [
  'opencode',
  'anthropic',
  'openai',
  'gemini',
  'ollama',
  'deepseek',
  'openrouter',
  'xai',
  'mistral',
  'groq',
  'custom'
]

/**
 * Where each provider hands out API keys. Every link here was checked against
 * the provider (a live response, or its own docs linking it) on 2026-09-24;
 * one that cannot be checked stays out rather than guessed.
 */
export const PROVIDER_KEY_URLS: Partial<Record<SecretProvider, string>> = {
  opencode: 'https://opencode.ai/auth',
  anthropic: 'https://platform.claude.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
  ollama: 'https://ollama.com/settings/keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  openrouter: 'https://openrouter.ai/settings/keys',
  xai: 'https://console.x.ai',
  mistral: 'https://console.mistral.ai',
  groq: 'https://console.groq.com/keys'
}
