import type { SettingsSection } from './types'
import { SHORTCUT_BINDINGS, type ShortcutId } from '@renderer/lib/shortcuts/bindings'
import { SHORTCUT_TITLES } from '@renderer/lib/shortcuts/labels'

export type SettingsSearchEntry = {
  id: string
  title: string
  keywords: string[]
  section: SettingsSection
}

/** Client-side index of settings fields for search navigation. */
export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  {
    id: 'active-model',
    title: 'Active model',
    keywords: ['model', 'composer', 'provider'],
    section: 'general'
  },
  {
    id: 'tab-autocomplete',
    title: 'Tab autocomplete',
    keywords: ['tab', 'autocomplete', 'ghost', 'inline', 'complete', 'fim', 'editor', 'files'],
    section: 'general'
  },
  {
    id: 'navigation',
    title: 'Navigation',
    keywords: ['navigation', 'home', 'sidebar', 'layout', 'sessions', 'startup', 'launch', 'default view'],
    section: 'general'
  },
  {
    id: 'workspaces',
    title: 'Workspaces',
    keywords: ['override', 'workspace', 'folder', 'tabs'],
    section: 'general'
  },
  {
    id: 'appearance-skin',
    title: 'Interface skin',
    keywords: [
      'appearance',
      'skin',
      'template',
      'proof',
      'bench',
      'native',
      'default',
      'contrast',
      'workshop',
      'elevation',
      'legibility',
      'instrument',
      'chrome'
    ],
    section: 'appearance'
  },
  {
    id: 'appearance-custom-css',
    title: 'User CSS overlay',
    keywords: ['appearance', 'css', 'stylesheet', 'custom', 'overlay', 'tokens', 'skin'],
    section: 'appearance'
  },
  {
    id: 'appearance-theme',
    title: 'Color mode',
    keywords: ['appearance', 'theme', 'dark', 'light', 'system', 'color mode'],
    section: 'appearance'
  },
  {
    id: 'appearance-font-scale',
    title: 'Text size',
    keywords: ['appearance', 'font', 'text', 'size', 'scale'],
    section: 'appearance'
  },
  {
    id: 'appearance-density',
    title: 'UI density',
    keywords: ['appearance', 'density', 'compact', 'comfortable', 'spacing'],
    section: 'appearance'
  },
  {
    id: 'active-provider',
    title: 'Active provider',
    keywords: ['openai', 'anthropic', 'ollama', 'custom', 'provider'],
    section: 'providers'
  },
  {
    id: 'ollama-url',
    title: 'Ollama base URL',
    keywords: ['ollama', 'url', 'local', 'cloud'],
    section: 'providers'
  },
  {
    id: 'custom-url',
    title: 'Custom OpenAI base URL',
    keywords: ['custom', 'openai', 'url', 'deepinfra', 'compatible'],
    section: 'providers'
  },
  {
    id: 'api-keys',
    title: 'API keys',
    keywords: ['secret', 'key', 'token', 'credentials'],
    section: 'providers'
  },
  {
    id: 'refresh-models',
    title: 'Refresh models',
    keywords: ['catalog', 'models', 'reload'],
    section: 'providers'
  },
  {
    id: 'show-thinking',
    title: 'Show thinking in chat',
    keywords: ['thinking', 'reasoning', 'display'],
    section: 'agent'
  },
  {
    id: 'keep-recent-turns',
    title: 'Keep recent turns',
    keywords: ['compaction', 'context', 'turns'],
    section: 'agent'
  },
  {
    id: 'auto-compact-threshold',
    title: 'Auto-compact threshold',
    keywords: ['compaction', 'context', 'threshold', 'auto-compact'],
    section: 'agent'
  },
  {
    id: 'agent-autonomous-mode',
    title: 'Autonomous mode',
    keywords: ['autonomous', 'unattended', 'auto-approve', 'background'],
    section: 'agent'
  },
  {
    id: 'agent-autonomous-questions',
    title: 'Questions in autonomous mode',
    keywords: ['autonomous', 'questions', 'ask', 'skip'],
    section: 'agent'
  },
  {
    id: 'agent-offline-wait',
    title: 'Offline wait budget',
    keywords: ['offline', 'wait', 'network', 'autonomous', 'budget'],
    section: 'agent'
  },
  {
    id: 'agent-run-spend-limit',
    title: 'Run spend limit',
    keywords: ['spend', 'cost', 'usd', 'budget', 'limit', 'run'],
    section: 'agent'
  },
  {
    id: 'agent-run-token-limit',
    title: 'Run token limit',
    keywords: ['tokens', 'budget', 'limit', 'run', 'usage'],
    section: 'agent'
  },
  {
    id: 'agent-persona',
    title: 'Persona',
    keywords: ['persona', 'identity', 'name', 'assistant'],
    section: 'agent'
  },
  {
    id: 'agent-tone',
    title: 'Tone',
    keywords: ['tone', 'voice', 'style', 'friendly', 'attitude'],
    section: 'agent'
  },
  {
    id: 'response-language',
    title: 'Response language',
    keywords: ['language', 'locale', 'translate', 'reply'],
    section: 'agent'
  },
  {
    id: 'response-verbosity',
    title: 'Answer length',
    keywords: ['verbosity', 'concise', 'balanced', 'detailed', 'length'],
    section: 'agent'
  },
  {
    id: 'workspace-rules',
    title: 'Workspace rules',
    keywords: ['agents.md', 'cursorrules', 'rules', 'reference', 'marketplace'],
    section: 'agent'
  },
  {
    id: 'memory-files',
    title: 'Memory files',
    keywords: ['memory', 'vyotiq', 'durable', 'reference'],
    section: 'agent'
  },
  {
    id: 'codeindex-enabled',
    title: 'Enable codebase index',
    keywords: ['codebase', 'index', 'semantic', 'codeindex', 'mdenseon', 'sparsegrep'],
    section: 'indexing'
  },
  {
    id: 'codeindex-embedder',
    title: 'Embedder',
    keywords: ['embedder', 'mdenseon', 'lfm2', 'ollama', 'hash', 'onnx', 'denseon', 'liquidai', 'gguf', 'llama.cpp', 'node-llama-cpp', 'codebase', 'multilingual', '1024'],
    section: 'indexing'
  },
  {
    id: 'codeindex-lfm2-ollama-model',
    title: 'LFM2 Ollama GGUF model',
    keywords: ['lfm2', 'ollama', 'gguf', 'liquidai', 'llama.cpp', 'node-llama-cpp', 'embedder', 'codeindex', 'embedding'],
    section: 'indexing'
  },
  {
    id: 'codeindex-auto-download',
    title: 'Auto-download model',
    keywords: ['download', 'onnx', 'model', 'codeindex', 'embedder'],
    section: 'indexing'
  },
  {
    id: 'codeindex-ollama-model',
    title: 'Ollama embedding model',
    keywords: ['ollama', 'embed', 'nomic', 'codeindex'],
    section: 'indexing'
  },
  {
    id: 'codeindex-status',
    title: 'Index status',
    keywords: ['reindex', 'status', 'indexing', 'download', 'sparsegrep', 'codebase'],
    section: 'indexing'
  },
  {
    id: 'process-metrics',
    title: 'Live processes',
    keywords: [
      'rss',
      'memory',
      'cpu',
      'electron',
      'onnx',
      'embed',
      'diagnostics',
      'task manager'
    ],
    section: 'indexing'
  },
  {
    id: 'dictation-engine',
    title: 'Dictation engine',
    keywords: [
      'dictation',
      'voice',
      'whisper',
      'transcribe',
      'microphone',
      'OpenRouter',
      'local model'
    ],
    section: 'voice'
  },
  {
    id: 'dictation-waveform',
    title: 'Waveform',
    keywords: [
      'dictation',
      'voice',
      'waveform',
      'bars',
      'dots',
      'line',
      'mirror',
      'microphone'
    ],
    section: 'voice'
  },
  {
    id: 'dictation-whisper-tiny',
    title: 'Whisper Tiny',
    keywords: ['dictation', 'voice', 'whisper', 'tiny', 'transcribe', 'local model', 'microphone'],
    section: 'voice'
  },
  {
    id: 'dictation-whisper-small',
    title: 'Whisper Small',
    keywords: [
      'dictation',
      'voice',
      'whisper',
      'small',
      'transcribe',
      'local model',
      'OpenRouter'
    ],
    section: 'voice'
  },
  {
    id: 'dictation-qwen3-server',
    title: 'Qwen3-ASR server URL',
    keywords: [
      'dictation',
      'voice',
      'qwen',
      'qwen3',
      'asr',
      'transcribe',
      'local server',
      'vllm',
      'microphone'
    ],
    section: 'voice'
  },
  {
    id: 'dictation-qwen3-key',
    title: 'Qwen3-ASR server API key',
    keywords: ['dictation', 'voice', 'qwen', 'qwen3', 'asr', 'api key', 'token'],
    section: 'voice'
  },
  {
    id: 'dictation-qwen3-asr-0.6b',
    title: 'Qwen3-ASR 0.6B',
    keywords: ['dictation', 'voice', 'qwen', 'qwen3', 'asr', 'transcribe', 'local server'],
    section: 'voice'
  },
  {
    id: 'dictation-qwen3-asr-1.7b',
    title: 'Qwen3-ASR 1.7B',
    keywords: ['dictation', 'voice', 'qwen', 'qwen3', 'asr', 'transcribe', 'local server'],
    section: 'voice'
  },
  {
    id: 'dictation-qwen3-asr-onnx-0.6b',
    title: 'Qwen3-ASR 0.6B (on-device)',
    keywords: ['dictation', 'voice', 'qwen', 'qwen3', 'asr', 'transcribe', 'local server', 'onnx', 'on-device'],
    section: 'voice'
  },
  {
    id: 'dictation-qwen3-asr-onnx-1.7b',
    title: 'Qwen3-ASR 1.7B (on-device)',
    keywords: ['dictation', 'voice', 'qwen', 'qwen3', 'asr', 'transcribe', 'local server', 'onnx', 'on-device'],
    section: 'voice'
  },
  {
    id: 'tool-approval',
    title: 'Tool approval',
    keywords: ['approval', 'allowlist', 'tools', 'mutating'],
    section: 'tools'
  },
  {
    id: 'mcp-tools-protection',
    title: 'MCP tools protection',
    keywords: ['mcp', 'approval', 'tools', 'protection', 'servers'],
    section: 'tools'
  },
  {
    id: 'terminal-shell',
    title: 'Terminal shell',
    keywords: ['shell', 'powershell', 'bash', 'cmd', 'terminal'],
    section: 'tools'
  },
  {
    id: 'terminal-screen-reader',
    title: 'Terminal screen reader',
    keywords: ['screen reader', 'accessibility', 'a11y', 'terminal', 'assistive'],
    section: 'tools'
  },
  {
    id: 'search-engine',
    title: 'Search engine',
    keywords: ['browser', 'search', 'duckduckgo', 'bing', 'google'],
    section: 'tools'
  },
  {
    id: 'browser-domain-allowlist',
    title: 'Browser domain allowlist',
    keywords: ['browser', 'domain', 'allowlist', 'hostname', 'navigation', 'restrict'],
    section: 'tools'
  },
  {
    id: 'auto-resume-interrupted',
    title: 'Auto-resume interrupted runs',
    keywords: ['resume', 'interrupted', 'continue', 'runs'],
    section: 'tools'
  },
  {
    id: 'auto-mode-switch',
    title: 'Automatic mode switching',
    keywords: ['mode', 'ask', 'plan', 'agent', 'switch'],
    section: 'tools'
  },
  {
    id: 'send-feedback',
    title: 'Send feedback',
    keywords: ['feedback', 'bug', 'feature request', 'praise', 'email', 'contact'],
    section: 'general'
  },
  {
    id: 'telemetry',
    title: 'Share crash & error reports',
    keywords: ['sentry', 'telemetry', 'crash', 'error', 'privacy', 'advanced'],
    section: 'general'
  },
  {
    id: 'notifications-enabled',
    title: 'Enable notifications',
    keywords: ['notifications', 'inbox', 'bell', 'alerts'],
    section: 'general'
  },
  {
    id: 'notifications-desktop',
    title: 'Desktop notifications',
    keywords: ['notifications', 'desktop', 'os', 'toast', 'unfocused'],
    section: 'general'
  },
  {
    id: 'notifications-run-finished',
    title: 'Agent run finished',
    keywords: ['notifications', 'run', 'finished', 'done', 'agent'],
    section: 'general'
  },
  {
    id: 'notifications-run-failed',
    title: 'Agent run failed',
    keywords: ['notifications', 'run', 'failed', 'error', 'agent'],
    section: 'general'
  },
  {
    id: 'notifications-needs-you',
    title: 'Agent needs you',
    keywords: ['notifications', 'approval', 'question', 'needs you', 'agent'],
    section: 'general'
  },
  {
    id: 'notifications-system',
    title: 'System alerts',
    keywords: ['notifications', 'crash', 'recovery', 'system'],
    section: 'general'
  },
  {
    id: 'logs',
    title: 'Logs',
    keywords: ['logs', 'folder', 'rotating', 'diagnostics', 'advanced'],
    section: 'general'
  },
  {
    id: 'recent-crashes',
    title: 'Recent crashes',
    keywords: ['crash', 'diagnostics', 'renderer', 'gpu', 'advanced'],
    section: 'general'
  },
  {
    id: 'trace-capture',
    title: 'Trace capture',
    keywords: ['trace', 'tracing', 'chrome://tracing', 'profiling', 'performance', 'flight recorder', 'crash', 'hang', 'diagnostics', 'advanced'],
    section: 'general'
  },
  {
    id: 'diagnostics-command',
    title: 'Diagnostics command',
    keywords: ['typecheck', 'diagnostics', 'tsc', 'advanced'],
    section: 'general'
  },
  {
    id: 'about',
    title: 'Vyotiq',
    keywords: ['about', 'logo', 'brand', 'company', 'agent v', 'vyotiq'],
    section: 'about'
  },
  {
    id: 'about-version',
    title: 'Version',
    keywords: ['version', 'build', 'release', 'about'],
    section: 'about'
  },
  {
    id: 'about-runtime',
    title: 'Runtime',
    keywords: ['electron', 'chromium', 'chrome', 'node', 'about'],
    section: 'about'
  },
  {
    id: 'about-platform',
    title: 'Platform',
    keywords: ['os', 'windows', 'macos', 'linux', 'arch', 'about'],
    section: 'about'
  },
  {
    id: 'about-copy',
    title: 'Copy build info',
    keywords: ['copy', 'clipboard', 'build', 'about'],
    section: 'about'
  },
  {
    id: 'about-website',
    title: 'Website',
    keywords: ['vyotiq.com', 'homepage', 'url', 'about'],
    section: 'about'
  },
  {
    id: 'about-docs',
    title: 'Docs',
    keywords: ['docs', 'documentation', 'vyotiq.com/docs', 'about'],
    section: 'about'
  },
  {
    id: 'about-auto-check',
    title: 'Check for updates on launch',
    keywords: ['updates', 'auto check', 'upgrade', 'about'],
    section: 'about'
  },
  {
    id: 'about-updater',
    title: 'App updates',
    keywords: ['updates', 'updater', 'upgrade', 'release', 'about'],
    section: 'about'
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    keywords: ['shortcut', 'keyboard', 'hotkey', 'keybinding', 'chords'],
    section: 'shortcuts'
  },
  ...(Object.keys(SHORTCUT_BINDINGS) as ShortcutId[]).map((id) => ({
    id: `shortcut-${id}`,
    title: SHORTCUT_TITLES[id],
    keywords: ['shortcut', 'keyboard', 'hotkey'],
    section: 'shortcuts' as const
  })),
  {
    id: 'shortcut-jump-latest',
    title: 'Jump to latest',
    keywords: ['shortcut', 'keyboard', 'hotkey', 'end'],
    section: 'shortcuts' as const
  },
  {
    id: 'shortcut-jump-top',
    title: 'Jump to top',
    keywords: ['shortcut', 'keyboard', 'hotkey', 'home'],
    section: 'shortcuts' as const
  },
  {
    id: 'shortcut-edit-last',
    title: 'Edit last prompt',
    keywords: ['shortcut', 'keyboard', 'hotkey', 'arrow'],
    section: 'shortcuts' as const
  },
  {
    id: 'shortcut-font-smaller',
    title: 'Smaller text',
    keywords: ['shortcut', 'keyboard', 'hotkey', 'font', 'zoom'],
    section: 'shortcuts' as const
  },
  {
    id: 'shortcut-font-larger',
    title: 'Larger text',
    keywords: ['shortcut', 'keyboard', 'hotkey', 'font', 'zoom'],
    section: 'shortcuts' as const
  },
  {
    id: 'shortcut-font-reset',
    title: 'Reset text size',
    keywords: ['shortcut', 'keyboard', 'hotkey', 'font', 'zoom'],
    section: 'shortcuts' as const
  }
]

export function filterSettingsSearch(
  query: string,
  index: SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX
): SettingsSearchEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return index.filter((entry) => {
    if (entry.title.toLowerCase().includes(q)) return true
    if (entry.id.toLowerCase().includes(q)) return true
    return entry.keywords.some((k) => k.toLowerCase().includes(q))
  })
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Conditional fields (provider/embedder-specific) scroll to the control that reveals them. */
const FIELD_SCROLL_FALLBACK: Record<string, string> = {
  'ollama-url': 'api-keys',
  'custom-url': 'api-keys',
  'codeindex-ollama-model': 'codeindex-embedder',
  'codeindex-lfm2-ollama-model': 'codeindex-embedder'
}

function querySettingsField(fieldId: string): HTMLElement | null {
  if (!fieldId) return null
  return document.querySelector<HTMLElement>(`[data-settings-field="${cssEscape(fieldId)}"]`)
}

export function scrollToSettingsField(fieldId: string): void {
  const el = querySettingsField(fieldId) ?? querySettingsField(FIELD_SCROLL_FALLBACK[fieldId] ?? '')
  if (!el) return
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
  el.classList.add('ring-1', 'ring-fg/25', 'rounded-md')
  window.setTimeout(() => {
    el.classList.remove('ring-1', 'ring-fg/25', 'rounded-md')
  }, 1600)
}
