import type { ModelInfo, ProviderIdAny, SlashCommandDescriptor, ThinkingEffort } from '@shared/ipc'
import { providerLabel } from '@shared/domain/providers'
import { resolveModelPrice } from '@shared/pricing/modelPrices'
import type { IconName } from '@renderer/lib/icons'
import { formatTokens } from '@renderer/lib/utils/formatTokens'
import { BUILTIN_COMMANDS } from '../../../../main/agent/slashCommands/builtins'
import { buildModes, type ThinkingModeOption } from '../../../../renderer/src/features/chat/components/composer/ThinkingControls'
import { effortFootNote, effortNotes } from '../../../../renderer/src/features/chat/components/composer/effortCost'
import {
  buildChatMentionItems,
  buildCommitMentionItems,
  buildDocsMentionItems,
  buildFileMentionItems,
  buildRootMentionItems,
  buildRuleMentionItems,
  type MentionMenuItem,
  type MentionMenuView
} from '../../../../renderer/src/features/chat/components/composer/mentionModel'
import { buildSlashDisplayList } from '../../../../renderer/src/features/chat/components/composer/useSlashCommands'

/*
  The one task every scene shows. Values are samples; every word around them
  comes from the app's own helpers, so labels, notes and orders are the
  shipped ones.
*/

export const PROVIDER: ProviderIdAny = 'anthropic'
export const MODEL_ID = 'claude-opus-5'
export const MODEL_LABEL = 'Claude Opus 5'
export const WORKSPACE = 'C:/Users/you/code/agent-v'
export const BRANCH = 'feat/glass-composer'

/** The providers column, in the app's order, with the keys this sample holds. */
export const PROVIDERS: { id: ProviderIdAny; note: string | null }[] = [
  { id: 'openai', note: null },
  { id: 'anthropic', note: null },
  { id: 'gemini', note: 'no key' },
  { id: 'ollama', note: 'local' },
  { id: 'deepseek', note: 'no key' },
  { id: 'openrouter', note: null }
]
export const providerName = (id: ProviderIdAny): string => providerLabel(id)

export type ModelRowData = { id: string; label: string; contextWindow: number; price: string; can: string[]; favorite: boolean }

function price(model: string): string {
  const resolved = resolveModelPrice(PROVIDER, model)
  if (!resolved) return ''
  const n = resolved.price.input
  return n === 0 ? 'free' : `$${n.toFixed(2)}`
}

/** Anthropic's tab: favourites, then recent, then the seeds (the app's own order). */
export const MODEL_ROWS: ModelRowData[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', contextWindow: 200_000, can: ['thinks', 'sees images', 'uses tools'], favorite: true },
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', contextWindow: 200_000, can: ['thinks', 'sees images', 'uses tools'], favorite: false },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200_000, can: ['thinks', 'sees images', 'uses tools'], favorite: false },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 200_000, can: ['thinks', 'sees images', 'uses tools'], favorite: false },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200_000, can: ['thinks', 'sees images', 'uses tools'], favorite: false }
].map((m) => ({ ...m, price: price(m.id) }))

export const MODEL_META: Pick<ModelInfo, 'thinkingMode'> = { thinkingMode: 'adaptive' }

/** The model's effort ladder, as ModelPicker builds it. */
export const EFFORT_MODES: ThinkingModeOption[] = buildModes(
  ['low', 'medium', 'high', 'xhigh', 'max'] as ThinkingEffort[],
  true,
  'adaptive',
  'high'
)
export const EFFORT_NOTES = effortNotes(EFFORT_MODES, { provider: PROVIDER, model: MODEL_ID, meta: MODEL_META })
export const EFFORT_FOOT = effortFootNote(PROVIDER, MODEL_ID)
export const DEFAULT_EFFORT = EFFORT_MODES.findIndex((m) => m.enabled && m.effort === 'high')

// ── Context ──────────────────────────────────────────────────────────────

export type Usage = {
  window: number
  used: number
  step: number
  /** Completed steps this run. */
  steps: number
  compactionTrigger: number
  estimate: boolean
  breakdown: { label: string; tokens: number; color: string; muted?: boolean; expandable?: boolean }[]
  run: { label: string; value: string; tone?: string; title?: string }[]
  reasoningNote: boolean
}

export const USAGE: Usage = {
  window: 200_000,
  used: 24_310,
  step: 43,
  steps: 42,
  compactionTrigger: 160_000,
  estimate: false,
  breakdown: [
    { label: 'Record', tokens: 9_840, color: 'bg-accent' },
    { label: 'System tools', tokens: 7_120, color: 'bg-fg' },
    { label: 'MCP tools', tokens: 2_210, color: 'bg-secondary', expandable: true },
    { label: 'System prompt', tokens: 3_480, color: 'bg-muted' },
    { label: 'Skills', tokens: 1_660, color: 'bg-tertiary' },
    { label: 'Autocompact buffer', tokens: 40_000, color: 'bg-border-strong' },
    { label: 'Free space', tokens: 135_690, color: 'bg-border' },
    { label: 'Deferred sys tools', tokens: 5_930, color: 'bg-border', muted: true },
    { label: 'Deferred MCP tools', tokens: 18_400, color: 'bg-border', muted: true, expandable: true }
  ],
  run: [
    { label: 'Completed steps', value: '42', title: 'Provider calls finished this run' },
    { label: 'Run cost', value: '$0.41 est.', tone: 'text-secondary', title: 'Estimated from published model rates — not a provider bill' },
    { label: 'Run input', value: formatTokens(212_400), title: 'Sum of billed input across all completed steps' },
    { label: 'Largest step', value: formatTokens(24_310), title: 'Peak context size in a single step' },
    { label: 'Output', value: formatTokens(6_120) },
    { label: 'Step cache', value: '92%', tone: 'text-success', title: 'Cache hit rate on the latest step' },
    { label: 'Run cache', value: '87%', tone: 'text-success', title: 'Cache hit rate across all completed steps' },
    { label: 'Cache write', value: formatTokens(18_200), tone: 'text-warning' },
    { label: 'Reasoning', value: `${formatTokens(3_910)} · 64%`, tone: 'text-warning' }
  ],
  reasoningNote: true
}

export const usageRatio = (u: Usage): number => Math.min(1, u.used / Math.max(1, u.window))
export const usagePct = (u: Usage): number => Math.round(usageRatio(u) * 100)

/** ContextMeter's formatPct. */
export function formatPct(n: number, total: number): string {
  if (total <= 0) return '0%'
  const pct = (n / total) * 100
  if (pct > 0 && pct < 1) return `${pct.toFixed(1)}%`
  if (pct >= 10) return `${Math.round(pct)}%`
  return `${pct.toFixed(1)}%`
}

// ── @ and / ──────────────────────────────────────────────────────────────

/** A sample workspace: what the @ menu's search and its lists find, through the app's own builders. */
const RECENT_FILES = ['src/renderer/src/features/chat/components/composer/Composer.tsx', 'src/renderer/src/styles.css']
const WORKSPACE_FILES = [
  'README.md',
  'src/renderer/src/features/chat/components/composer/Composer.tsx',
  'src/renderer/src/features/chat/components/composer/ModelPicker.tsx',
  'src/renderer/src/features/chat/components/composer/ContextMeter.tsx',
  'src/renderer/src/features/chat/components/composer/AttachMenu.tsx',
  'src/renderer/src/styles.css',
  'src/renderer/src/lib/ui/Button.tsx',
  'docs/composer.md',
  'package.json'
]
const WORKSPACE_FOLDERS = ['src/renderer/src/features/chat/components/composer', 'src/renderer/src/lib/ui', 'docs']
/** Files and folders shows this many, then "Show N more". */
const FILES_SHOWN = 6

const has = (query: string, ...texts: string[]): boolean => {
  const q = query.trim().toLowerCase()
  return !q || texts.some((t) => t.toLowerCase().includes(q))
}

/** The @ menu's rows for a query, in its root list or one it browsed into. */
export function mentionItems(view: MentionMenuView, query: string, more: boolean): MentionMenuItem[] {
  switch (view) {
    case 'root':
      return buildRootMentionItems({
        query,
        recentFiles: RECENT_FILES,
        matchingFiles: WORKSPACE_FILES.filter((p) => has(query, p)),
        matchingFolders: WORKSPACE_FOLDERS.filter((p) => has(query, p)),
        branchName: BRANCH
      })
    case 'files': {
      // Main pages files and ranks folders apart; the builder merges the two.
      const files = WORKSPACE_FILES.filter((p) => has(query, p))
      const shown = more ? files.length : Math.min(FILES_SHOWN, files.length)
      return buildFileMentionItems(files.slice(0, shown), files.length, shown, {
        paths: WORKSPACE_FOLDERS.filter((p) => has(query, p)),
        query
      })
    }
    case 'docs':
      return buildDocsMentionItems(['README.md', 'docs/composer.md', 'docs/voice-mode.md'].filter((p) => has(query, p)))
    case 'rules':
      return buildRuleMentionItems(
        [
          { path: 'AGENTS.md', alwaysApply: true },
          { path: '.cursor/rules/ui.mdc', description: 'Tokens, icons and focus rings', alwaysApply: false }
        ].filter((r) => has(query, r.path, r.description ?? ''))
      )
    case 'commits':
      return buildCommitMentionItems(
        [
          { sha: '73b7a8e7c1', shortSha: '73b7a8e', subject: 'fix(agent): keep run storage consistent', author: 'you', relativeDate: '2 hours ago' },
          { sha: 'e007926a44', shortSha: 'e007926', subject: 'fix(mcp): read every page', author: 'you', relativeDate: 'yesterday' },
          { sha: '471350f0b2', shortSha: '471350f', subject: 'fix(context): keep folds honest', author: 'you', relativeDate: '2 days ago' }
        ].filter((c) => has(query, c.subject, c.shortSha))
      )
    case 'chats':
      return buildChatMentionItems(
        [
          { runId: 'r1', goal: 'Restyle the instruction line in dark glass', updatedAt: new Date(Date.now() - 3_600_000).toISOString() },
          { runId: 'r2', goal: 'Port the dictation take to Moonshine', updatedAt: new Date(Date.now() - 86_400_000).toISOString() }
        ].filter((r) => has(query, r.goal))
      )
  }
}

const SKILL: SlashCommandDescriptor = {
  id: 'skill:design-level-up',
  kind: 'skill',
  trigger: 'design-level-up',
  label: 'Design level-up',
  description:
    'Make AI-built design look professional: 25 techniques in Easy, Intermediate and Advanced levels, from a design system to motion.',
  group: 'Skills',
  availability: 'ready'
} as SlashCommandDescriptor

/** What `/` lists for a query, from the app's own display builder. */
export const slashCommands = (query: string): SlashCommandDescriptor[] => buildSlashDisplayList(query, [SKILL, ...BUILTIN_COMMANDS])

// ── What is attached, typed or queued ────────────────────────────────────

/** A small drawn screenshot standing in for a pasted image. */
export const SAMPLE_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#2a2a2a"/><rect x="8" y="10" width="64" height="8" rx="2" fill="#555"/><rect x="8" y="26" width="40" height="6" rx="2" fill="#444"/><rect x="8" y="38" width="52" height="6" rx="2" fill="#444"/><rect x="8" y="56" width="28" height="14" rx="7" fill="#777"/></svg>'
  )

export const SAMPLE_FILE = { name: 'composer-notes.md', chars: 4_820 }

export type Segment =
  | { type: 'text'; value: string }
  | { type: 'chip'; kind: 'file'; path: string }
  | { type: 'chip'; kind: 'slash'; trigger: string; slashKind: SlashCommandDescriptor['kind'] }
  | { type: 'chip'; kind: 'branch'; label: string }
  /** Any other @ context (the browser, a terminal, lints…): its menu row's glyph and label. */
  | { type: 'chip'; kind: 'context'; label: string; icon: IconName }

export const TYPED: Segment[] = [
  { type: 'chip', kind: 'slash', trigger: 'design-level-up', slashKind: 'skill' },
  { type: 'text', value: ' restyle the instruction line in ' },
  { type: 'chip', kind: 'file', path: 'src/renderer/src/features/chat/components/composer/Composer.tsx' },
  { type: 'text', value: ' to match the screenshot — keep every control where it is.' }
]

export const STEER: Segment[] = [{ type: 'text', value: 'Skip the light theme for now — dark only.' }]

export const DICTATED = 'make the context meter open upward and keep the send button visible'

/** What Structure wrote over the words, as the field shows it after. */
export const STRUCTURED: Segment[] = [
  {
    type: 'text',
    value:
      'Goal: restyle the instruction line in dark glass.\nScope: Composer.tsx and its popovers — no behaviour changes.\nDone when:\n- every control keeps its place and label\n- pnpm typecheck passes'
  }
]

export const FOLLOW_UPS = [
  { id: 'f1', preview: 'Then run the composer tests and fix anything that breaks', offline: false },
  { id: 'f2', preview: 'And update the screenshot in docs/composer.md', offline: true }
]

export const BRIEF_TEXT: Segment[] = [
  {
    type: 'text',
    value: 'Rebuild the composer’s popovers in the glass material: model and effort, context, attach, dictation setup, @ and /.'
  }
]
export const BRIEF_CHECKS = ['pnpm typecheck passes', 'eslint . is clean']

export const ERROR_TEXT = 'Anthropic API error 529: Overloaded'
