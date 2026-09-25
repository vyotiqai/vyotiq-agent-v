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
    title: 'Open on launch',
    keywords: ['home', 'sidebar', 'layout', 'sessions', 'startup', 'launch', 'default view'],
    section: 'general'
  },
  {
    id: 'max-chat-panes',
    title: 'Tasks side by side',
    keywords: ['split', 'panes', 'sessions', 'columns', 'layout', 'side by side'],
    section: 'general'
  },
  {
    id: 'workspaces',
    title: 'Workspaces',
    keywords: ['workspace', 'override', 'per-workspace', 'folder', 'project', 'add workspace'],
    section: 'general'
  },

  // Appearance
  {
    id: 'appearance-skin',
    title: 'Skin',
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
    title: 'Mode',
    keywords: ['appearance', 'theme', 'dark', 'light', 'system', 'dark mode', 'colour mode', 'color mode'],
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
    title: 'Density',
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
    title: 'Notifications',
    keywords: ['notifications', 'inbox', 'bell', 'alerts'],
    section: 'notifications'
  },
  {
    id: 'notifications-desktop',
    title: 'Desktop alerts',
    keywords: ['notifications', 'desktop', 'os', 'toast', 'background', 'unfocused'],
    section: 'notifications'
  },
  {
    id: 'notifications-run-finished',
    title: 'A task finished',
    keywords: ['notifications', 'run', 'finished', 'done', 'complete', 'ready for review', 'task'],
    section: 'notifications'
  },
  {
    id: 'notifications-run-failed',
    title: 'A task failed',
    keywords: ['notifications', 'run', 'failed', 'error'],
    section: 'notifications'
  },
  {
    id: 'notifications-needs-you',
    title: 'A task needs you',
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
    title: 'Provider for new tasks',
    keywords: ['provider', 'openai', 'anthropic', 'gemini', 'ollama', 'openrouter', 'custom'],
    section: 'providers'
  },
  {
    id: 'active-model',
    title: 'Model',
    keywords: ['model', 'composer', 'provider', 'llm', 'refresh', 'reload', 'model list', 'catalog'],
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
    title: 'Ask before',
    keywords: ['approval', 'permissions', 'ask', 'confirm', 'mutating', 'tools', 'tool approval'],
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
    title: 'MCP tools always ask',
    keywords: ['mcp', 'approval', 'protection', 'servers', 'permissions'],
    section: 'agent'
  },
  {
    id: 'agent-autonomous-mode',
    title: 'Unattended mode',
    keywords: ['autonomous', 'unattended', 'auto-approve', 'yolo', 'background', 'permissions', 'autonomous mode'],
    section: 'agent'
  },
  {
    id: 'agent-autonomous-questions',
    title: 'Questions while unattended',
    keywords: ['autonomous', 'questions', 'ask', 'skip', 'wait'],
    section: 'agent'
  },
  {
    id: 'auto-mode-switch',
    title: 'Switch between Ask and Agent on its own',
    keywords: ['mode', 'ask', 'agent', 'switch', 'switch_mode'],
    section: 'agent'
  },
  {
    id: 'auto-resume-interrupted',
    title: 'Resume interrupted runs',
    keywords: ['resume', 'interrupted', 'continue', 'runs'],
    section: 'agent'
  },
  {
    id: 'parallel-instances',
    title: 'Instances at once',
    keywords: ['instances', 'sub-agents', 'subagents', 'parallel', 'spawn', 'limit'],
    section: 'agent'
  },
  {
    id: 'show-thinking',
    title: 'Show reasoning',
    keywords: ['thinking', 'reasoning', 'display', 'show thinking'],
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
    title: 'Compact at',
    keywords: ['compaction', 'context', 'threshold', 'auto-compact', 'window', 'auto-compact threshold', 'percent'],
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
    title: 'Shell',
    keywords: ['shell', 'powershell', 'bash', 'cmd', 'terminal', 'terminal shell'],
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
    title: 'Allowed sites',
    keywords: ['browser domain allowlist', 'browser', 'domain', 'allowlist', 'hostname', 'navigation', 'restrict', 'allowed sites', 'sites'],
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
    title: 'Servers',
    keywords: ['mcp', 'servers', 'connect', 'marketplace', 'integrations'],
    section: 'tools'
  },
  {
    id: 'tools-catalog',
    title: 'Catalog',
    keywords: ['tools', 'catalog', 'mcp', 'active', 'available', 'built-in'],
    section: 'tools'
  },

  // Indexing
  {
    id: 'codeindex-enabled',
    title: 'Codebase index',
    keywords: ['codebase', 'index', 'codeindex', 'search', 'embedding', 'semantic', 'concept', 'reindex', 'status', 'syncing', 'progress', 'workspaces'],
    section: 'indexing'
  },

  // Voice
  {
    id: 'dictation-engine',
    title: 'Engine',
    keywords: ['dictation', 'voice', 'whisper', 'transcribe', 'microphone', 'speech', 'dictation engine', 'local', 'openai', 'openrouter'],
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
    title: 'Usage',
    keywords: ['storage', 'disk', 'usage', 'report', 'size', 'space', 'app data', 'cap', 'managed'],
    section: 'storage'
  },
  {
    id: 'storage-free-up',
    title: 'Free up space now',
    keywords: ['storage', 'cleanup', 'reclaim', 'delete', 'orphan', 'untracked', 'disk'],
    section: 'storage'
  },
  {
    id: 'storage-checkpoint-gc',
    title: 'Clean up undo points',
    keywords: ['checkpoints', 'undo', 'retention', 'evict', 'storage', 'checkpoint cleanup', 'undo points'],
    section: 'storage'
  },
  {
    id: 'storage-checkpoint-keep',
    title: 'Keep undo points of the newest',
    keywords: ['checkpoints', 'undo', 'retention', 'count', 'undo points', 'tasks'],
    section: 'storage'
  },
  {
    id: 'storage-checkpoint-age',
    title: 'Keep undo points for',
    keywords: ['checkpoints', 'undo', 'retention', 'days', 'age', 'undo points', 'checkpoint max age'],
    section: 'storage'
  },
  {
    id: 'storage-session-retention',
    title: 'Delete old tasks',
    keywords: ['sessions', 'history', 'transcripts', 'retention', 'delete', 'tasks', 'automatic session retention'],
    section: 'storage'
  },
  {
    id: 'storage-session-keep',
    title: 'Always keep the newest',
    keywords: ['sessions', 'history', 'retention', 'count', 'tasks', 'keep sessions'],
    section: 'storage'
  },
  {
    id: 'storage-session-age',
    title: 'Keep tasks for',
    keywords: ['sessions', 'history', 'retention', 'days', 'age', 'tasks', 'session max age'],
    section: 'storage'
  },
  {
    id: 'storage-orphan-reaper',
    title: 'Clean up untracked storage',
    keywords: ['orphan', 'untracked', 'workspace', 'storage', 'reap'],
    section: 'storage'
  },
  {
    id: 'storage-orphan-grace',
    title: 'Grace period',
    keywords: ['orphan', 'untracked', 'grace', 'days', 'untracked grace period', 'idle'],
    section: 'storage'
  },
  {
    id: 'storage-prune-on-removal',
    title: 'Delete storage when closing a workspace',
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
    title: 'Share crash and error reports',
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
    title: 'Agent V',
    keywords: ['about', 'brand', 'license', 'agent v', 'vyotiq', 'version', 'build', 'release', 'electron', 'chromium', 'chrome', 'node', 'os', 'platform', 'windows', 'macos', 'linux', 'arch'],
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
    id: 'about-copy',
    title: 'Copy build info',
    keywords: ['copy build info', 'copy', 'clipboard', 'build', 'bug report', 'about'],
    section: 'about'
  },
  {
    id: 'about-auto-check',
    title: 'Check automatically',
    keywords: ['check for updates automatically', 'updates', 'auto check', 'periodic', 'upgrade'],
    section: 'about'
  },
  {
    id: 'about-updater',
    title: 'Updates',
    keywords: ['updates', 'updater', 'upgrade', 'release', 'version', 'check now', 'download', 'restart', 'install'],
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
 * Where a result lands when its own row is not mounted: the provider URL rows
 * are rows of the API key list, and the allowlist belongs to the approval
 * mode above it.
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

/**
 * Scroll to a row that may not exist yet. From outside Settings (the palette)
 * the view loads lazily and its rows wait for settings, so this waits for the
 * row — or its fallback — to mount, and gives up after `timeoutMs`.
 */
export function revealSettingsFieldWhenMounted(fieldId: string, timeoutMs = 3000): void {
  const started = Date.now()
  const tick = (): void => {
    if (querySettingsField(fieldId) ?? querySettingsField(FIELD_SCROLL_FALLBACK[fieldId] ?? '')) {
      scrollToSettingsField(fieldId)
      return
    }
    if (Date.now() - started < timeoutMs) window.requestAnimationFrame(tick)
  }
  window.requestAnimationFrame(tick)
}

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
