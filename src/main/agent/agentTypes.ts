import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { ProviderIdAny, Settings } from '../../shared/ipc'
import { ProviderIdSchema, isCustomProviderId } from '../../shared/ipc/schemas/providers'
import { providerNeedsKey, resolveProviderChatBaseUrl, seedModelsFor } from '../../shared/providers'
import { logger } from '../../shared/logger'
import { getSecret } from '@main/settings/secrets'
import { userDataRoot } from '@main/storage/paths'
import { BUILTIN_TOOL_NAMES, canonicalizeAgentToolName } from './schemas/tools'
import { parseMarkdownFrontmatter } from './skills/parse'
import { wrapPromptSection } from './promptSections'

/**
 * User-defined helper agent types: markdown files whose frontmatter names a
 * helper (name, description, optional tools and model) and whose body is the
 * helper's instructions. `spawn_agent_instance` takes one by `agent_type`.
 *
 * Read from, most specific first (the first file to claim a name wins):
 *   1. `<workspace>/.vyotiq/agent-types/*.md`
 *   2. `<workspace>/.claude/agents/*.md` — Claude Code's subagent files, same frontmatter
 *   3. `<userData>/agent-types/*.md` — the user's own, in every workspace
 *
 * Not `.vyotiq/agents/`: that is the retired profiles feature's data root, and
 * writeGuard keeps runs out of it.
 */

export type AgentTypeSource = 'workspace' | 'claude' | 'user'

export type AgentTypeDefinition = {
  name: string
  description: string
  /** Canonical tool names the helper may use; absent = every tool its mode allows. */
  tools?: string[]
  /** Model as written: inherit, sonnet/opus/haiku, `provider:model`, or a model id. */
  model?: string
  /** The helper's instructions. */
  body: string
  source: AgentTypeSource
  /** Where it was read from, as shown to the model and the user. */
  displayPath: string
}

export type AgentTypeIssue = {
  displayPath: string
  severity: 'error' | 'warning'
  message: string
}

export type AgentTypeCatalog = { types: AgentTypeDefinition[]; issues: AgentTypeIssue[] }

/** A type as spawn_agent_instance applies it to one child. */
export type ResolvedAgentType = {
  name: string
  body: string
  /** The child's whole tool allowlist (declared tools plus bookkeeping); absent = unrestricted. */
  tools?: string[]
  model?: string
}

const MAX_FILE_BYTES = 64 * 1024
const MAX_TYPES_PER_ROOT = 64
const MAX_BODY_CHARS = 32_000
const SECTION_MAX_CHARS = 6_000
const SECTION_DESCRIPTION_MAX_CHARS = 300

const AgentTypeFrontmatterSchema = z.object({
  name: z
    .string({ error: 'name is required' })
    .trim()
    .min(1, 'name is required')
    .max(64, 'name must be at most 64 characters')
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'name may use only letters, digits, - and _'),
  description: z
    .string({ error: 'description is required' })
    .trim()
    .min(1, 'description is required')
    .max(2_000, 'description must be at most 2000 characters'),
  tools: z.array(z.string()).optional(),
  model: z.string().trim().min(1).max(200).optional()
})

/**
 * Tools a typed helper keeps whatever its list says: they are the run's own
 * bookkeeping (its todo list, its plan, its done-when verdicts), not a
 * capability, and the harness asks every Agent-mode run for them.
 */
export const AGENT_TYPE_BOOKKEEPING_TOOLS = ['todo_write', 'create_plan', 'check_done_when'] as const

/** What loading an MCP server takes: a helper granted any MCP tool needs these to reach it. */
const MCP_LOADER_TOOLS = ['mcp_list_tools', 'request_mcp_tools', 'release_mcp_tools'] as const

/** Tools a helper can never hold: it cannot nest, and goals belong to the root task. */
const HELPER_EXCLUDED_TOOLS = new Set([
  'spawn_agent_instance',
  'await_agent_instance',
  'pull_agent_instance',
  'merge_agent_instance',
  'cancel_agent_instance',
  'create_goal',
  'update_goal'
])

/**
 * Claude Code tool names that are not a plain alias of one builtin. Keys are
 * lowercase with separators removed.
 */
const CLAUDE_CODE_TOOL_MAP: Record<string, readonly string[]> = {
  edit: ['edit', 'str_replace'],
  multiedit: ['str_replace', 'edit'],
  write: ['edit'],
  bash: ['terminal'],
  bashoutput: ['terminal'],
  killbash: ['terminal'],
  killshell: ['terminal'],
  ls: ['list_dir'],
  notebookread: ['read'],
  notebookedit: ['edit_notebook'],
  webfetch: ['browser_navigate', 'browser_snapshot'],
  websearch: ['browser_search'],
  todowrite: ['todo_write']
}

const BUILTIN_SET = new Set<string>(BUILTIN_TOOL_NAMES)

function compactKey(name: string): string {
  return name.toLowerCase().replace(/[\s_-]/g, '')
}

/** The `tools` field: a comma list, a `[a, b]` flow list, or a `- a` block list. */
function readToolsField(yaml: string, value: unknown): string[] | undefined {
  if (typeof value === 'string' && value.trim()) {
    const flat = value.trim().replace(/^\[/, '').replace(/\]$/, '')
    return flat
      .split(',')
      .map((t) => t.trim().replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
  }
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => /^tools:\s*$/.test(line.trim()) && !/^\s/.test(line))
  if (start < 0) return undefined
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    const item = /^\s*-\s+(.+)$/.exec(line)
    if (!item) {
      if (!line.trim()) continue
      break
    }
    const name = item[1]!.trim().replace(/^["']|["']$/g, '').trim()
    if (name) out.push(name)
  }
  return out.length > 0 ? out : undefined
}

/** Map one written tool name to builtin / MCP names; null when unknown. */
function mapToolName(raw: string): { names: string[] } | { dropped: string } {
  const name = raw.trim()
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length)
    const sep = rest.indexOf('__')
    if (sep < 0) return rest ? { names: [`mcp__${rest}`] } : { dropped: `"${name}" names no MCP server` }
    const server = rest.slice(0, sep)
    const tool = rest.slice(sep + 2)
    if (!server) return { dropped: `"${name}" names no MCP server` }
    // `mcp__server__*` is the whole server.
    return { names: [tool === '*' || !tool ? `mcp__${server}` : `mcp__${server}__${tool}`] }
  }
  const mapped = CLAUDE_CODE_TOOL_MAP[compactKey(name)]
  if (mapped) return { names: [...mapped] }
  const canonical = canonicalizeAgentToolName(name)
  if (BUILTIN_SET.has(canonical)) return { names: [canonical] }
  return { dropped: `unknown tool "${name}"` }
}

/** Declared tools → canonical names, with what had to be dropped. */
export function mapAgentTypeTools(written: readonly string[]): { tools: string[]; dropped: string[] } {
  const tools: string[] = []
  const dropped: string[] = []
  for (const raw of written) {
    const mapped = mapToolName(raw)
    if ('dropped' in mapped) {
      dropped.push(mapped.dropped)
      continue
    }
    for (const name of mapped.names) {
      if (HELPER_EXCLUDED_TOOLS.has(name)) {
        dropped.push(`"${raw.trim()}" (helpers cannot spawn helpers or set goals)`)
        continue
      }
      if (!tools.includes(name)) tools.push(name)
    }
  }
  return { tools, dropped }
}

export type ParseAgentTypeResult =
  | { ok: true; type: Omit<AgentTypeDefinition, 'source' | 'displayPath'>; warnings: string[] }
  | { ok: false; error: string }

/** Parse one agent-type markdown file. Never throws. */
export function parseAgentTypeMarkdown(raw: string): ParseAgentTypeResult {
  const split = parseMarkdownFrontmatter(raw)
  if (!split) return { ok: false, error: 'must start with a closed --- YAML frontmatter block' }
  const writtenTools = readToolsField(split.yaml, split.fields.tools)
  const parsed = AgentTypeFrontmatterSchema.safeParse({
    name: typeof split.fields.name === 'string' && split.fields.name ? split.fields.name : undefined,
    description:
      typeof split.fields.description === 'string' && split.fields.description
        ? split.fields.description
        : undefined,
    tools: writtenTools,
    model: typeof split.fields.model === 'string' && split.fields.model ? split.fields.model : undefined
  })
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') }
  }
  const warnings: string[] = []
  let tools: string[] | undefined
  if (parsed.data.tools) {
    const mapped = mapAgentTypeTools(parsed.data.tools)
    if (mapped.dropped.length > 0) warnings.push(`tools ignored: ${mapped.dropped.join(', ')}`)
    if (mapped.tools.length === 0) {
      return { ok: false, error: 'tools names no tool a helper can use' }
    }
    tools = mapped.tools
  }
  let body = split.body.trim()
  if (body.length > MAX_BODY_CHARS) {
    warnings.push(`instructions cut to ${MAX_BODY_CHARS} characters`)
    body = body.slice(0, MAX_BODY_CHARS)
  }
  return {
    ok: true,
    type: {
      name: parsed.data.name,
      description: parsed.data.description.replace(/\s+/g, ' ').trim(),
      ...(tools ? { tools } : {}),
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      body
    },
    warnings
  }
}

let userAgentTypesDirOverride: string | null = null

/** @internal Vitest: point the user-level dir at a temp tree (null restores it). */
export function setUserAgentTypesDirForTests(dir: string | null): void {
  userAgentTypesDirOverride = dir
  catalogCache.clear()
}

export function userAgentTypesDir(): string {
  if (userAgentTypesDirOverride) return userAgentTypesDirOverride
  return join(userDataRoot(), 'agent-types')
}

type Root = { dir: string; source: AgentTypeSource; display: string }

function rootsFor(workspacePath: string | null): Root[] {
  const roots: Root[] = []
  if (workspacePath) {
    roots.push({ dir: join(workspacePath, '.vyotiq', 'agent-types'), source: 'workspace', display: '.vyotiq/agent-types' })
    roots.push({ dir: join(workspacePath, '.claude', 'agents'), source: 'claude', display: '.claude/agents' })
  }
  let userDir: string | null = null
  try {
    userDir = userAgentTypesDir()
  } catch {
    // Outside Electron with no override: no user-level types.
  }
  if (userDir) roots.push({ dir: userDir, source: 'user', display: '<userData>/agent-types' })
  return roots
}

type RootListing = { root: Root; files: { name: string; path: string; stamp: string }[] }

function listRoot(root: Root): RootListing {
  let names: string[]
  try {
    names = readdirSync(root.dir)
  } catch {
    return { root, files: [] }
  }
  const files: RootListing['files'] = []
  for (const name of names.filter((n) => n.toLowerCase().endsWith('.md')).sort((a, b) => a.localeCompare(b))) {
    const path = join(root.dir, name)
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      files.push({ name, path, stamp: `${st.mtimeMs}:${st.size}` })
    } catch {
      // Gone between readdir and stat.
    }
  }
  return { root, files }
}

type CacheEntry = { fingerprint: string; catalog: AgentTypeCatalog }
const catalogCache = new Map<string, CacheEntry>()
/** Issues already logged, so an unchanged bad file warns once, not every step. */
const loggedIssues = new Set<string>()

/** @internal */
export function clearAgentTypesCache(): void {
  catalogCache.clear()
  loggedIssues.clear()
}

/**
 * Every agent type visible from a workspace, with the files that could not be
 * used. Cached on each file's mtime and size, so an edit, add or delete is
 * seen on the next call without a watcher.
 */
export function loadAgentTypes(workspacePath: string | null | undefined): AgentTypeCatalog {
  const ws = workspacePath?.trim() || null
  const listings = rootsFor(ws).map(listRoot)
  const fingerprint = listings
    .map((l) => `${l.root.dir}|${l.files.map((f) => `${f.name}=${f.stamp}`).join(',')}`)
    .join('\n')
  const key = ws ?? ''
  const cached = catalogCache.get(key)
  if (cached && cached.fingerprint === fingerprint) return cached.catalog

  const types: AgentTypeDefinition[] = []
  const issues: AgentTypeIssue[] = []
  const seen = new Map<string, string>()
  for (const { root, files } of listings) {
    for (const file of files.slice(0, MAX_TYPES_PER_ROOT)) {
      const displayPath = `${root.display}/${file.name}`
      let raw: string
      try {
        if (statSync(file.path).size > MAX_FILE_BYTES) {
          issues.push({ displayPath, severity: 'error', message: `larger than ${MAX_FILE_BYTES / 1024} KB` })
          continue
        }
        raw = readFileSync(file.path, 'utf8')
      } catch (err) {
        issues.push({ displayPath, severity: 'error', message: err instanceof Error ? err.message : String(err) })
        continue
      }
      const parsed = parseAgentTypeMarkdown(raw)
      if (!parsed.ok) {
        issues.push({ displayPath, severity: 'error', message: parsed.error })
        continue
      }
      for (const warning of parsed.warnings) issues.push({ displayPath, severity: 'warning', message: warning })
      const nameKey = parsed.type.name.toLowerCase()
      const winner = seen.get(nameKey)
      if (winner) {
        issues.push({
          displayPath,
          severity: 'warning',
          message: `"${parsed.type.name}" is already defined by ${winner}, which wins`
        })
        continue
      }
      seen.set(nameKey, displayPath)
      types.push({ ...parsed.type, source: root.source, displayPath })
    }
    if (files.length > MAX_TYPES_PER_ROOT) {
      issues.push({
        displayPath: root.display,
        severity: 'warning',
        message: `only the first ${MAX_TYPES_PER_ROOT} files are read`
      })
    }
  }
  for (const issue of issues) {
    const logKey = `${fingerprint}\0${issue.displayPath}\0${issue.message}`
    if (loggedIssues.has(logKey)) continue
    loggedIssues.add(logKey)
    logger.warn('Agent type file skipped or partly used', {
      scope: 'agentTypes',
      path: issue.displayPath,
      severity: issue.severity,
      reason: issue.message
    })
  }
  const catalog = { types, issues }
  catalogCache.set(key, { fingerprint, catalog })
  return catalog
}

export function findAgentType(catalog: AgentTypeCatalog, name: string): AgentTypeDefinition | undefined {
  const key = name.trim().toLowerCase()
  return catalog.types.find((t) => t.name.toLowerCase() === key)
}

/** The tool error for a name no file defines: what does exist, and what was skipped. */
export function unknownAgentTypeError(catalog: AgentTypeCatalog, name: string): string {
  const names = catalog.types.map((t) => t.name)
  const lines = [
    names.length > 0
      ? `Unknown agent_type "${name}". Available: ${names.join(', ')}. Omit agent_type for a general helper.`
      : `Unknown agent_type "${name}": no agent types are defined (.vyotiq/agent-types/*.md, .claude/agents/*.md, or the user's agent-types folder). Omit agent_type for a general helper.`
  ]
  const errors = catalog.issues.filter((i) => i.severity === 'error')
  if (errors.length > 0) {
    lines.push(`Files that could not be read: ${errors.map((i) => `${i.displayPath} (${i.message})`).join('; ')}`)
  }
  return lines.join('\n')
}

/** The child's allowlist: its declared tools, its bookkeeping, and MCP loading when it holds any MCP tool. */
export function agentTypeToolAllowlist(tools: readonly string[] | undefined): string[] | undefined {
  if (!tools) return undefined
  const out = [...tools]
  for (const name of AGENT_TYPE_BOOKKEEPING_TOOLS) if (!out.includes(name)) out.push(name)
  if (tools.some((t) => t.startsWith('mcp__'))) {
    for (const name of MCP_LOADER_TOOLS) if (!out.includes(name)) out.push(name)
  }
  return out
}

export function resolveAgentType(def: AgentTypeDefinition): ResolvedAgentType {
  const tools = agentTypeToolAllowlist(def.tools)
  return {
    name: def.name,
    body: def.body,
    ...(tools ? { tools } : {}),
    ...(def.model ? { model: def.model } : {})
  }
}

/**
 * The `<agent_types>` list a root Agent run reads. It sits beside the skills
 * list in the stable prompt zone and, like it, changes only when a file does —
 * the tool schema stays static so it never moves the cached prefix.
 */
export function buildAgentTypesSection(types: readonly AgentTypeDefinition[]): string {
  if (types.length === 0) return ''
  const header =
    'Helper types for `spawn_agent_instance`: pass `agent_type` with a name below and the child runs with that type’s instructions, tool list and model. Omit it for a general helper.\n'
  let used = header.length
  const lines: string[] = [header]
  for (const type of types) {
    const description =
      type.description.length > SECTION_DESCRIPTION_MAX_CHARS
        ? `${type.description.slice(0, SECTION_DESCRIPTION_MAX_CHARS - 1)}…`
        : type.description
    const tools = type.tools ? ` (tools: ${type.tools.join(', ')})` : ''
    const line = `- **${type.name}**: ${description}${tools}\n`
    if (used + line.length > SECTION_MAX_CHARS) {
      lines.push('\n_More agent types omitted to fit the prompt._')
      break
    }
    lines.push(line)
    used += line.length
  }
  return wrapPromptSection('agent_types', lines.join('').trim())
}

/** The child prompt's tail: the type's instructions, after the brief. */
export function formatAgentTypeInstructions(type: Pick<ResolvedAgentType, 'name' | 'body'>): string {
  const body = type.body.trim()
  const lead = `You are running as the "${type.name}" helper type. ${body ? 'Its instructions below apply to this whole task, alongside the brief above.' : 'It has no instructions beyond the brief above.'}`
  return wrapPromptSection('agent_type', body ? `${lead}\n\n${body}` : lead)
}

export type ModelChoice = { provider: ProviderIdAny; model: string }

const MODEL_FAMILY_ALIASES = new Set(['sonnet', 'opus', 'haiku'])

/** `anthropic:claude-opus-5` or `custom:slug:model` → provider + model. */
function splitProviderModel(spec: string): ModelChoice | null {
  const custom = /^(custom:[a-z0-9-]{1,40}):(.+)$/.exec(spec)
  if (custom && isCustomProviderId(custom[1]!)) return { provider: custom[1] as ProviderIdAny, model: custom[2]!.trim() }
  const sep = spec.indexOf(':')
  if (sep <= 0) return null
  const provider = ProviderIdSchema.safeParse(spec.slice(0, sep))
  const model = spec.slice(sep + 1).trim()
  if (!provider.success || !model) return null
  return { provider: provider.data, model }
}

/**
 * Whether a provider can run a request now: it has a key, or needs none. The
 * same test the utility model uses (sideModels.ts).
 */
export function providerHasCredentials(provider: ProviderIdAny, settings: Settings): boolean {
  try {
    const apiKey = getSecret(provider)
    const baseUrl = resolveProviderChatBaseUrl(provider, settings, apiKey)
    return !providerNeedsKey(provider, baseUrl ?? settings.ollamaBaseUrl) || Boolean(apiKey?.trim())
  } catch {
    return false
  }
}

/**
 * The model a typed helper runs on. Without a model (or with one that cannot
 * run here) it is the general helper's: the helper model, else the task's.
 *
 * - `inherit`: the task's own model.
 * - `sonnet` / `opus` / `haiku`: that family on the first provider with
 *   credentials — the task's, the helper model's, then Anthropic.
 * - `provider:model` (e.g. `anthropic:claude-opus-5`): exactly that.
 * - anything else is a model id, on whichever of those providers lists it,
 *   else on the helper's (or task's) provider.
 */
export function resolveAgentTypeModel(
  spec: string | undefined,
  ctx: {
    parent: ModelChoice | null
    helper: ModelChoice | null
    hasCredentials: (provider: ProviderIdAny) => boolean
  }
): { choice: ModelChoice | null; note?: string } {
  const fallback = ctx.helper ?? ctx.parent
  const wanted = spec?.trim()
  if (!wanted) return { choice: fallback }
  const lower = wanted.toLowerCase()
  if (lower === 'inherit') return { choice: ctx.parent ?? ctx.helper }

  const providers: ProviderIdAny[] = []
  for (const p of [ctx.parent?.provider, ctx.helper?.provider, 'anthropic' as const]) {
    if (p && !providers.includes(p)) providers.push(p)
  }
  const usable = providers.filter((p) => ctx.hasCredentials(p))
  const unusable = (why: string): { choice: ModelChoice | null; note: string } => ({
    choice: fallback,
    note: `model "${wanted}" ${why}; the helper runs on ${fallback ? `${fallback.provider}:${fallback.model}` : 'the default model'} instead.`
  })

  if (MODEL_FAMILY_ALIASES.has(lower)) {
    for (const provider of usable) {
      // The task's or helper's own model already is that family: keep its exact id.
      const current = [ctx.parent, ctx.helper].find((c) => c?.provider === provider && c.model.toLowerCase().includes(lower))
      if (current) return { choice: current }
      const seed = seedModelsFor(provider).find((m) => m.id.toLowerCase().includes(lower))
      if (seed) return { choice: { provider, model: seed.id } }
    }
    return unusable('matches no model on a provider with credentials')
  }

  const explicit = splitProviderModel(wanted)
  if (explicit) {
    return ctx.hasCredentials(explicit.provider) ? { choice: explicit } : unusable(`needs ${explicit.provider} credentials`)
  }

  for (const provider of usable) {
    if (seedModelsFor(provider).some((m) => m.id === wanted)) return { choice: { provider, model: wanted } }
  }
  const home = fallback?.provider
  if (home && ctx.hasCredentials(home)) return { choice: { provider: home, model: wanted } }
  return unusable('has no provider with credentials')
}
