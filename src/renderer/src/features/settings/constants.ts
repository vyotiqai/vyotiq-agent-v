import { PROVIDER_DEFAULTS } from '@shared/providers'
import type { SettingsSection } from './types'

export const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

export const FONT_SCALE_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' }
]

export const DENSITY_OPTIONS = [
  { value: 'compact', label: 'Compact' },
  { value: 'default', label: 'Default' },
  { value: 'comfortable', label: 'Comfortable' }
]

export const ACCENT_OPTIONS = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'blue', label: 'Blue' },
  { value: 'violet', label: 'Violet' },
  { value: 'green', label: 'Green' }
]

export const TOOL_APPROVAL_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'mutating', label: 'Ask for edits and commands' },
  { value: 'all', label: 'Ask for every tool' }
]

export const TERMINAL_SHELL_OPTIONS = [
  { value: 'auto', label: 'Auto (PowerShell on Windows when available)' },
  { value: 'cmd', label: 'Windows cmd.exe' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'bash', label: 'Bash' }
]

export const TERMINAL_SCREEN_READER_OPTIONS = [
  { value: 'auto', label: 'Auto (detect screen reader)' },
  { value: 'on', label: 'Always on' },
  { value: 'off', label: 'Off' }
]

export const RESPONSE_VERBOSITY_OPTIONS = [
  { value: 'concise', label: 'Concise' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'detailed', label: 'Detailed' }
]

export const NAVIGATION_MODE_OPTIONS = [
  { value: 'home', label: 'Home page' },
  { value: 'sidebar', label: 'Sidebar' }
]

/** Mirrors the zod maxes in shared/ipc/schemas/settings.ts. */
export const PERSONA_MAX_LENGTH = 1000
export const TONE_MAX_LENGTH = 2000
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

export const AUTONOMOUS_QUESTIONS_OPTIONS = [
  { value: 'wait', label: 'Wait for answers' },
  { value: 'skip', label: 'Skip questions' }
]

export const OFFLINE_WAIT_OPTIONS = [
  { value: 'default', label: 'Default wait budget' },
  { value: 'extended', label: 'Extended wait budget' },
  { value: 'wait_forever', label: 'Wait indefinitely' }
]

export const ACTIVE_PROVIDER_OPTIONS = PROVIDER_DEFAULTS.map((p) => ({
  value: p.id,
  label: p.label
}))

export const CODEINDEX_EMBEDDER_OPTIONS = [
  { value: 'mdenseon', label: 'LightOn dense ONNX (default — batched, utility process)' },
  { value: 'lfm2', label: 'LFM2.5-Embedding-350M (llama.cpp / Ollama, 1024-dim)' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'hash', label: 'Local hash (offline bag-of-tokens fallback)' }
]

export const DICTATION_ENGINE_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'local', label: 'Local' },
  { value: 'qwen3-asr', label: 'Qwen3-ASR (local server)' },
  { value: 'qwen3-asr-onnx', label: 'Qwen3-ASR (on-device)' }
]

export const DICTATION_WAVEFORM_STYLE_OPTIONS = [
  { value: 'bars', label: 'Bars' },
  { value: 'dots', label: 'Dots' },
  { value: 'line', label: 'Line' },
  { value: 'mirror', label: 'Mirror' }
]

export const SECTION_LABELS: Record<SettingsSection, { title: string }> = {
  general: { title: 'General' },
  appearance: { title: 'Appearance' },
  providers: { title: 'Providers' },
  agent: { title: 'Agent' },
  indexing: { title: 'Indexing' },
  voice: { title: 'Voice' },
  tools: { title: 'Tools' },
  shortcuts: { title: 'Shortcuts' },
  about: { title: 'About' }
}
