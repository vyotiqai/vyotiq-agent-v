import type { SettingsSection } from './types'
import { shortcutGroups } from './utils/shortcutGroups'

export type SettingsSearchEntry = {
  id: string
  title: string
  keywords: string[]
  section: SettingsSection
}

/**
 * Client-side index of settings rows for search navigation, in nav order.
 *
 * Every `id` is a `data-settings-field` a section renders, and `title` is that
 * row's title. `settings-view.test.tsx` checks both directions — each rendered
 * row is indexed, and each entry here is rendered — because the index is
 * edited by hand and drifted twice: two results pointed at ids no row carried,
 * so picking them changed section and then scrolled nowhere.
 */
export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  // General
  {
    id: 'navigation',
    title: 'Navigation',
    keywords: ['home', 'sidebar', 'layout', 'sessions', 'startup', 'launch', 'default view'],
    section: 'general'
  },
  {
    id: 'max-chat-panes',
    title: 'Max chat panes',
    keywords: ['split', 'panes', 'sessions', 'columns', 'layout', 'side by side'],
    section: 'general'
  },
  {
    id: 'workspaces',
    title: 'Open workspaces',
    keywords: ['workspace', 'override', 'per-workspace', 'folder', 'project', 'add workspace'],
    section: 'general'
  },

  // Appearance
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
      'gild',
      'contrast',
      'elevation',
      'instrument',
      'look'
    ],
    section: 'appearance'
  },
  {
    id: 'appearance-theme',
    title: 'Color mode',
    keywords: ['appearance', 'theme', 'dark', 'light', 'system', 'dark mode'],
    section: 'appearance'
  },
  {
    id: 'appearance-font-scale',
    title: 'Text size',
    keywords: ['appearance', 'font', 'text', 'size', 'scale', 'zoom'],
    section: 'appearance'
  },
  {
    id: 'appearance-density',
    title: 'UI density',
    keywords: ['appearance', 'density', 'compact', 'comfortable', 'spacing', 'padding'],
    section: 'appearance'
  },
  {
    id: 'appearance-custom-css',
    title: 'User CSS overlay',
    keywords: ['appearance', 'css', 'stylesheet', 'custom', 'overlay', 'tokens'],
    section: 'appearance'
  },

  // Notifications
  {
    id: 'notifications-enabled',
    title: 'Enable notifications',
    keywords: ['notifications', 'inbox', 'bell', 'alerts'],
    section: 'notifications'
  },
  {
    id: 'notifications-desktop',
    title: 'Desktop notifications',
    keywords: ['notifications', 'desktop', 'os', 'toast', 'background', 'unfocused'],
    section: 'notifications'
  },
  {
    id: 'notifications-run-finished',
    title: 'Agent run finished',
    keywords: ['notifications', 'run', 'finished', 'done', 'complete'],
    section: 'notifications'
  },
  {
    id: 'notifications-run-failed',
    title: 'Agent run failed',
    keywords: ['notifications', 'run', 'failed', 'error'],
    section: 'notifications'
  },
  {
    id: 'notifications-needs-you',
    title: 'Agent needs you',
    keywords: ['notifications', 'approval', 'question', 'needs you', 'waiting'],
    section: 'notifications'
  },
  {
    id: 'notifications-system',
    title: 'System alerts',
    keywords: ['notifications', 'crash', 'recovery', 'system'],
    section: 'notifications'
  },

  // Shortcuts
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    keywords: ['shortcut', 'keyboard', 'hotkey', 'keybinding', 'chords'],
    section: 'shortcuts'
  },
  ...shortcutGroups().flatMap((group) =>
    group.entries.map((entry) => ({
      id: `shortcut-${entry.id}`,
      title: entry.title,
      keywords: ['shortcut', 'keyboard', 'hotkey', group.title.toLowerCase(), entry.label.toLowerCase()],
      section: 'shortcuts' as const
    }))
  ),

  // Providers
  {
    id: 'active-provider',
    title: 'Active provider',
    keywords: ['provider', 'openai', 'anthropic', 'gemini', 'ollama', 'openrouter', 'custom'],
    section: 'providers'
  },
  {
    id: 'active-model',
    title: 'Active model',
    keywords: ['model', 'composer', 'provider', 'llm'],
    section: 'providers'
  },
  {
    id: 'refresh-models',
    title: 'Refresh models',
    keywords: ['catalog', 'models', 'reload', 'model list'],
    section: 'providers'
  },
  {
    id: 'api-keys',
    title: 'API keys',
    keywords: ['secret', 'key', 'token', 'credentials', 'secure storage'],
    section: 'providers'
  },
  {
    id: 'ollama-url',
    title: 'Ollama base URL',
    keywords: ['ollama', 'url', 'local', 'cloud', 'host'],
    section: 'providers'
  },
  {
    id: 'custom-url',
    title: 'Custom OpenAI base URL',
    keywords: ['custom', 'openai', 'url', 'deepinfra', 'compatible', 'endpoint'],
    section: 'providers'
  },

  // Agent
  {
    id: 'tool-approval',
    title: 'Tool approval',
    keywords: ['approval', 'permissions', 'ask', 'confirm', 'mutating', 'tools'],
    section: 'agent'
  },
  {
    id: 'tool-approval-allowlist',
    title: 'Always allowed',
    keywords: ['approval', 'allowlist', 'always allow', 'allowed tools', 'permissions'],
    section: 'agent'
  },
  {
    id: 'mcp-tools-protection',
    title: 'MCP tools protection',
    keywords: ['mcp', 'approval', 'protection', 'servers', 'permissions'],
    section: 'agent'
  },
  {
    id: 'agent-autonomous-mode',
    title: 'Autonomous mode',
    keywords: ['autonomous', 'unattended', 'auto-approve', 'yolo', 'background', 'permissions'],
    section: 'agent'
  },
  {
    id: 'agent-autonomous-questions',
    title: 'Questions in autonomous mode',
    keywords: ['autonomous', 'questions', 'ask', 'skip', 'wait'],
    section: 'agent'
  },
  {
    id: 'auto-mode-switch',
    title: 'Automatic mode switching',
    keywords: ['mode', 'ask', 'agent', 'switch', 'switch_mode'],
    section: 'agent'
  },
  {
    id: 'auto-resume-interrupted',
    title: 'Auto-resume interrupted runs',
    keywords: ['resume', 'interrupted', 'continue', 'runs'],
    section: 'agent'
  },
  {
    id: 'show-thinking',
    title: 'Show thinking',
    keywords: ['thinking', 'reasoning', 'display'],
    section: 'agent'
  },
  {
    id: 'keep-recent-turns',
    title: 'Keep recent turns',
    keywords: ['compaction', 'context', 'turns', 'history'],
    section: 'agent'
  },
  {
    id: 'auto-compact-threshold',
    title: 'Auto-compact threshold',
    keywords: ['compaction', 'context', 'threshold', 'auto-compact', 'window'],
    section: 'agent'
  },
  {
    id: 'agent-persona',
    title: 'Name',
    keywords: ['persona', 'name', 'assistant', 'identity'],
    section: 'agent'
  },
  {
    id: 'agent-identity',
    title: 'Identity',
    keywords: ['identity', 'role', 'persona', 'about', 'instructions'],
    section: 'agent'
  },
  {
    id: 'agent-tone',
    title: 'Tone',
    keywords: ['tone', 'style', 'friendly', 'blunt', 'formal', 'attitude'],
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
    title: 'Rules',
    keywords: ['rules', 'agents.md', 'claude.md', 'cursorrules', 'instructions', 'marketplace'],
    section: 'agent'
  },

  // Tools
  {
    id: 'terminal-shell',
    title: 'Terminal shell',
    keywords: ['shell', 'powershell', 'bash', 'cmd', 'terminal'],
    section: 'tools'
  },
  {
    id: 'diagnostics-command',
    title: 'Diagnostics command',
    keywords: ['typecheck', 'lint', 'diagnostics', 'tsc', 'eslint', 'check'],
    section: 'tools'
  },
  {
    id: 'terminal-screen-reader',
    title: 'Screen reader mode',
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
    title: 'Domain allowlist',
    keywords: ['browser domain allowlist', 'browser', 'domain', 'allowlist', 'hostname', 'navigation', 'restrict'],
    section: 'tools'
  },
  {
    id: 'mcp-tool-loading',
    title: 'Preload every MCP tool',
    keywords: ['mcp', 'tools', 'context', 'tokens', 'schemas', 'on demand', 'eager', 'load'],
    section: 'tools'
  },
  {
    id: 'mcp-servers',
    title: 'MCP servers',
    keywords: ['mcp', 'servers', 'connect', 'marketplace', 'integrations'],
    section: 'tools'
  },
  {
    id: 'tools-catalog',
    title: 'Live tool catalog',
    keywords: ['tools', 'catalog', 'mcp', 'active', 'available', 'built-in'],
    section: 'tools'
  },

  // Indexing
  {
    id: 'codeindex-enabled',
    title: 'Enable codebase index',
    keywords: ['codebase', 'index', 'codeindex', 'search', 'embedding', 'semantic', 'concept'],
    section: 'indexing'
  },
  {
    id: 'codeindex-status',
    title: 'Index status',
    keywords: ['reindex', 'status', 'syncing', 'codebase', 'progress'],
    section: 'indexing'
  },

  // Voice
  {
    id: 'dictation-engine',
    title: 'Dictation engine',
    keywords: ['dictation', 'voice', 'whisper', 'transcribe', 'microphone', 'speech'],
    section: 'voice'
  },
  {
    id: 'dictation-waveform',
    title: 'Waveform',
    keywords: ['dictation', 'voice', 'waveform', 'bars', 'dots', 'line', 'mirror'],
    section: 'voice'
  },
  {
    id: 'dictation-whisper-tiny',
    title: 'Whisper Tiny',
    keywords: ['dictation', 'voice', 'whisper', 'tiny', 'local model', 'offline'],
    section: 'voice'
  },
  {
    id: 'dictation-whisper-small',
    title: 'Whisper Small',
    keywords: ['dictation', 'voice', 'whisper', 'small', 'local model', 'offline'],
    section: 'voice'
  },

  // Storage
  {
    id: 'storage-usage',
    title: 'App data',
    keywords: ['storage', 'disk', 'usage', 'report', 'size', 'space'],
    section: 'storage'
  },
  {
    id: 'storage-free-up',
    title: 'Free up space',
    keywords: ['storage', 'cleanup', 'reclaim', 'delete', 'orphan', 'untracked', 'disk'],
    section: 'storage'
  },
  {
    id: 'storage-checkpoint-gc',
    title: 'Checkpoint cleanup',
    keywords: ['checkpoints', 'undo', 'retention', 'evict', 'storage'],
    section: 'storage'
  },
  {
    id: 'storage-checkpoint-keep',
    title: 'Keep checkpoint sessions',
    keywords: ['checkpoints', 'undo', 'retention', 'count'],
    section: 'storage'
  },
  {
    id: 'storage-checkpoint-age',
    title: 'Checkpoint max age',
    keywords: ['checkpoints', 'undo', 'retention', 'days', 'age'],
    section: 'storage'
  },
  {
    id: 'storage-session-retention',
    title: 'Automatic session retention',
    keywords: ['sessions', 'history', 'transcripts', 'retention', 'delete'],
    section: 'storage'
  },
  {
    id: 'storage-session-keep',
    title: 'Keep sessions',
    keywords: ['sessions', 'history', 'retention', 'count'],
    section: 'storage'
  },
  {
    id: 'storage-session-age',
    title: 'Session max age',
    keywords: ['sessions', 'history', 'retention', 'days', 'age'],
    section: 'storage'
  },
  {
    id: 'storage-orphan-reaper',
    title: 'Untracked storage cleanup',
    keywords: ['orphan', 'untracked', 'workspace', 'storage', 'reap'],
    section: 'storage'
  },
  {
    id: 'storage-orphan-grace',
    title: 'Untracked grace period',
    keywords: ['orphan', 'untracked', 'grace', 'days'],
    section: 'storage'
  },
  {
    id: 'storage-prune-on-removal',
    title: 'Delete storage when removing a workspace',
    keywords: ['remove', 'workspace', 'delete', 'storage', 'prune', 'close'],
    section: 'storage'
  },
  {
    id: 'storage-size-cap',
    title: 'Managed size cap',
    keywords: ['cap', 'limit', 'size', 'gb', 'storage', 'quota'],
    section: 'storage'
  },

  // Diagnostics
  {
    id: 'telemetry',
    title: 'Share crash & error reports',
    keywords: ['sentry', 'telemetry', 'crash', 'error', 'privacy', 'reports'],
    section: 'diagnostics'
  },
  {
    id: 'logs',
    title: 'Logs',
    keywords: ['logs', 'folder', 'troubleshooting', 'diagnostics'],
    section: 'diagnostics'
  },
  {
    id: 'trace-capture',
    title: 'Trace capture',
    keywords: ['trace', 'tracing', 'chrome://tracing', 'profiling', 'performance', 'hang'],
    section: 'diagnostics'
  },
  {
    id: 'recent-crashes',
    title: 'Recent crashes',
    keywords: ['crash', 'renderer', 'gpu', 'exit', 'diagnostics'],
    section: 'diagnostics'
  },
  {
    id: 'process-metrics',
    title: 'Memory',
    keywords: ['memory', 'rss', 'ram', 'processes', 'task manager', 'performance'],
    section: 'diagnostics'
  },

  // About
  {
    id: 'about',
    title: 'Vyotiq',
    keywords: ['about', 'brand', 'license', 'agent v', 'vyotiq'],
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
    keywords: ['docs', 'documentation', 'help', 'about'],
    section: 'about'
  },
  {
    id: 'about-source',
    title: 'Source',
    keywords: ['github', 'repository', 'repo', 'source', 'open source', 'about'],
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
    title: 'Build info',
    keywords: ['copy build info', 'copy', 'clipboard', 'build', 'bug report', 'about'],
    section: 'about'
  },
  {
    id: 'about-auto-check',
    title: 'Automatic checks',
    keywords: ['check for updates automatically', 'updates', 'auto check', 'periodic', 'upgrade'],
    section: 'about'
  },
  {
    id: 'about-updater',
    title: 'App updates',
    keywords: ['updates', 'updater', 'upgrade', 'release', 'version'],
    section: 'about'
  },
  {
    id: 'send-feedback',
    title: 'Send feedback',
    keywords: ['feedback', 'bug', 'feature request', 'praise', 'email', 'contact', 'support'],
    section: 'about'
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

/**
 * Rows that only render in some states scroll to the row that owns them: the
 * provider URLs live inside the API key accordion, and the approval allowlist
 * only exists once a tool has been allowed.
 */
const FIELD_SCROLL_FALLBACK: Record<string, string> = {
  'ollama-url': 'api-keys',
  'custom-url': 'api-keys',
  'tool-approval-allowlist': 'tool-approval'
}

function querySettingsField(fieldId: string): HTMLElement | null {
  if (!fieldId) return null
  return document.querySelector<HTMLElement>(`[data-settings-field="${cssEscape(fieldId)}"]`)
}

/** The flash a search result leaves on its row, so the eye lands on it. */
const HIGHLIGHT = ['ring-1', 'ring-border-strong', 'rounded-md']

export function scrollToSettingsField(fieldId: string): void {
  const el = querySettingsField(fieldId) ?? querySettingsField(FIELD_SCROLL_FALLBACK[fieldId] ?? '')
  if (!el) return
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
  el.classList.add(...HIGHLIGHT)
  window.setTimeout(() => {
    el.classList.remove(...HIGHLIGHT)
  }, 1600)
}
