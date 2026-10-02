import type { MarketplaceOverrides } from '../../../shared/ipc'
import { BUILTIN_TOOL_NAMES, canonicalizeAgentToolName } from '../schemas/tools'
import { findWorkspaceSettingsOverride, getWorkspaces } from '../../workspace/workspaces'
import { findEnabledSkillByName, type LoadedSkill } from './index'

/**
 * A skill's `allowed-tools`, with Claude Code's meaning: the tools the skill
 * may use without asking while it is active. It pre-approves; it does not
 * restrict — a tool it leaves out asks exactly as it would have.
 *
 * "Active" is one invoke (one turn of the task): from the Skill tool call that
 * loaded it, or from the start of a turn the user opened with `/name`.
 *
 * A pre-approval is an allow rule like your own (permissions.ts): deny and ask
 * rules, the protected paths and the built-in secret asks all come first, and
 * the command guard (tools/dangerousCommand.ts) still holds what it holds.
 *
 * Only skills the user put there count. A workspace's own skills
 * (`.vyotiq/skills`, `.cursor/skills`) came with the folder, which can hand a
 * run anything; and a Marketplace package counts only when it shipped with the
 * app (`installSource: 'bundled'`), since others were written by whoever
 * published them. Personal skills (`~/.vyotiq/skills`) are yours.
 */

export type SkillToolAllow = {
  /** The entry as the skill wrote it, for the log and the record. */
  entry: string
  /** Canonical tool names it covers; an `mcp__server__*` pattern ends in `*`. */
  tools: string[]
  /** terminal / run_tests: the command it covers. Absent: any command. */
  command?: { words: string[]; exact: boolean }
  /** File tools: a glob every path the call touches must match. */
  path?: { pattern: string; rootAnchored: boolean }
  /** browser_navigate: the host (or a subdomain of it) it may open. */
  domain?: string
}

export type ParsedAllowedTools = {
  allows: SkillToolAllow[]
  /** Entries that named nothing we know, or a spec we cannot read narrowly. */
  ignored: string[]
}

const BUILTIN = new Set<string>(BUILTIN_TOOL_NAMES)

/** Claude Code names that mean more than one tool here. Keys are compact (lowercase, no `_`). */
const CLAUDE_TOOLS: Record<string, string[]> = {
  bash: ['terminal', 'run_tests'],
  edit: ['edit', 'str_replace'],
  multiedit: ['edit', 'str_replace'],
  write: ['edit'],
  notebookread: ['read'],
  grep: ['grep', 'search'],
  webfetch: [
    'browser_navigate',
    'browser_snapshot',
    'browser_back',
    'browser_forward',
    'browser_scroll',
    'browser_wait_for_text',
    'browser_wait_for_selector',
    'browser_wait_for_url'
  ],
  websearch: ['browser_search']
}

const COMMAND_TOOLS = new Set(['terminal', 'run_tests'])
const PATH_TOOLS = new Set([
  'read',
  'list_dir',
  'glob',
  'grep',
  'search',
  'edit',
  'str_replace',
  'edit_notebook',
  'delete',
  'lsp',
  'git_apply'
])

const MCP_NAME = /^mcp__[A-Za-z0-9_.-]+?(?:__[A-Za-z0-9_.*-]+)?$/

/** Split at commas and spaces outside parentheses: `Bash(git status:*), Read`. */
function splitEntries(raw: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of raw) {
    if (ch === '(') depth++
    if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out.map((e) => e.replace(/^["']|["']$/g, '')).filter(Boolean)
}

function toolsFor(name: string): string[] | null {
  if (name.startsWith('mcp__')) {
    if (!MCP_NAME.test(name)) return null
    const rest = name.slice('mcp__'.length)
    // `mcp__server` is every tool of that server, as in Claude Code.
    if (!rest.includes('__')) return rest.includes('*') ? null : [`${name}__*`]
    const [server, tool] = [rest.slice(0, rest.indexOf('__')), rest.slice(rest.indexOf('__') + 2)]
    if (!server || server.includes('*') || !tool) return null
    // A wildcard only as the whole tool part or its tail: `mcp__gh__*`, `mcp__gh__get_*`.
    if (tool.includes('*') && tool.indexOf('*') !== tool.length - 1) return null
    return [name]
  }
  const compact = name.toLowerCase().replace(/[\s_]/g, '')
  const mapped = CLAUDE_TOOLS[compact]
  if (mapped) return mapped
  const canonical = canonicalizeAgentToolName(name)
  return BUILTIN.has(canonical) ? [canonical] : null
}

function commandSpec(spec: string): SkillToolAllow['command'] | 'any' | null {
  const s = spec.trim()
  if (s === '' || s === '*' || s === ':*') return 'any'
  let body = s
  let exact = true
  if (body.endsWith(':*')) {
    body = body.slice(0, -2)
    exact = false
  } else if (/\s\*$/.test(body)) {
    body = body.slice(0, -1)
    exact = false
  }
  // A wildcard anywhere else (`git * main`) cannot be matched word for word.
  if (!body.trim() || body.includes('*')) return null
  return { words: body.trim().split(/\s+/), exact }
}

/**
 * A path spec as Claude Code reads one: `//x` is absolute, `/x` is from the
 * workspace root, `~/x` from home, anything else relative.
 */
function pathSpec(spec: string): SkillToolAllow['path'] | 'any' | null {
  const s = spec.trim()
  if (s === '' || s === '*' || s === '**') return 'any'
  if (s.startsWith('//')) return { pattern: s.slice(1), rootAnchored: false }
  if (s.startsWith('/')) {
    const rel = s.replace(/^\/+/, '')
    return rel ? { pattern: rel, rootAnchored: true } : 'any'
  }
  return { pattern: s, rootAnchored: false }
}

export function parseAllowedTools(raw: string | undefined): ParsedAllowedTools {
  const out: ParsedAllowedTools = { allows: [], ignored: [] }
  if (!raw?.trim()) return out
  for (const entry of splitEntries(raw)) {
    const m = /^([A-Za-z0-9_.*-]+)(?:\((.*)\))?$/s.exec(entry)
    const tools = m ? toolsFor(m[1]!) : null
    if (!m || !tools) {
      out.ignored.push(entry)
      continue
    }
    const spec = m[2]
    if (spec === undefined) {
      out.allows.push({ entry, tools })
      continue
    }
    if (tools.some((t) => COMMAND_TOOLS.has(t))) {
      const command = commandSpec(spec)
      if (!command) out.ignored.push(entry)
      else {
        const only = tools.filter((t) => COMMAND_TOOLS.has(t))
        out.allows.push(command === 'any' ? { entry, tools: only } : { entry, tools: only, command })
      }
      continue
    }
    if (tools.includes('browser_navigate') && /^domain:/i.test(spec.trim())) {
      const domain = spec.trim().slice('domain:'.length).trim().toLowerCase().replace(/^\*\./, '')
      if (domain && /^[a-z0-9.-]+$/.test(domain) && domain.includes('.')) {
        out.allows.push({ entry, tools: ['browser_navigate'], domain })
      } else out.ignored.push(entry)
      continue
    }
    if (tools.every((t) => PATH_TOOLS.has(t))) {
      const path = pathSpec(spec)
      if (!path) out.ignored.push(entry)
      else out.allows.push(path === 'any' ? { entry, tools } : { entry, tools, path })
      continue
    }
    // A spec on a tool that takes none: reading it as "no limit" would widen it.
    out.ignored.push(entry)
  }
  return out
}

/** True when a skill's `allowed-tools` are honoured: see the note at the top. */
export function skillAllowedToolsTrusted(skill: Pick<LoadedSkill, 'source' | 'installSource'>): boolean {
  switch (skill.source) {
    case 'personal':
      return true
    case 'skill':
    case 'plugin':
      return skill.installSource === 'bundled'
    case 'project':
      return false
    default: {
      const _exhaustive: never = skill.source
      return _exhaustive
    }
  }
}

export type SkillToolGrant = {
  /** The skill's own name, as the Skill tool resolved it. */
  skill: string
  trusted: boolean
  source: LoadedSkill['source']
  allows: SkillToolAllow[]
  ignored: string[]
}

/** What `allowed-tools` grants for this skill name, as the Skill tool would resolve it. */
export function resolveSkillToolGrant(
  name: string,
  overrides: MarketplaceOverrides | null,
  workspaceRoot: string
): SkillToolGrant | null {
  const skill = findEnabledSkillByName(name, overrides, workspaceRoot)
  if (!skill) return null
  const parsed = parseAllowedTools(skill.allowedTools)
  return {
    skill: skill.name,
    trusted: skillAllowedToolsTrusted(skill),
    source: skill.source,
    allows: parsed.allows,
    ignored: parsed.ignored
  }
}

/** The resolver a run's approval gate uses, with the workspace's Marketplace overrides. */
export function skillToolGrantResolver(workspaceRoot: string): (name: string) => SkillToolGrant | null {
  return (name) => {
    const overrides = findWorkspaceSettingsOverride(getWorkspaces(), workspaceRoot)?.marketplaceOverrides ?? null
    return resolveSkillToolGrant(name, overrides, workspaceRoot)
  }
}
