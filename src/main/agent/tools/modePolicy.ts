import { basename } from 'path'
import type { AgentInteractionMode } from '../../../shared/ipc'
import { parseMcpToolName } from '../mcp'
import { wrapPromptSection } from '../promptSections'
import { AGENT_ONLY_BUILTIN, INLINE_OMIT_BUILTIN } from './classify'
import { lspActionFromArgs } from './lsp'

/** Options for mode policy gates (tool allowlists + mode section prompts). */
export type ModePolicyOptions = {
  /** When true, agent may call `switch_mode`. Default false. */
  autoModeSwitch?: boolean
  /** When true, omit root-only instance tools (depth-1 nesting). */
  inlineInstance?: boolean
}

/**
 * Built-in tools allowed in Ask mode (read-only / parallel-safe).
 * `browser_search` intentionally navigates the agent browser to a search URL
 * (browse-only — same egress as `browser_navigate`; not click/type/fill).
 */
export const ASK_SAFE_BUILTIN = new Set([
  'read',
  'search',
  'glob',
  'grep',
  'codebase_search',
  'concept_search',
  'list_dir',
  'browser_search',
  'ask_question',
  // Browse-only: click/type/fill/press_key/select can mutate live sites.
  'browser_navigate',
  'browser_snapshot',
  'browser_scroll',
  'browser_tabs',
  'browser_back',
  'browser_forward',
  'browser_wait_for_selector',
  'browser_wait_for_url',
  'browser_wait_for_text',
  'browser_hover',
  // Catalog listers only. `mcp_read_resource` / `mcp_get_prompt` call into a
  // server and return server-controlled content, so they stay Agent-only like
  // every other MCP invocation.
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_list_prompts',
  'memory_list',
  'memory_read',
  'Skill',
  'git_status',
  'git_diff',
  'lsp'
  // `diagnostics` spawns a shell — Agent-only, not Ask.
])

/** Run-artifact filenames that live in the run directory, not the workspace. */
export const PLAN_ARTIFACT_NAMES = new Set(['contract.md', 'plan.md'])

export function isPlanArtifactPath(pathArg: string): boolean {
  const p = pathArg.replace(/\\/g, '/').replace(/^\.\//, '')
  return PLAN_ARTIFACT_NAMES.has(basename(p))
}

/** Workspace-relative path with `./` stripped — not nested `src/contract.md`. */
function exactRunArtifactRelPath(pathArg: string): string {
  return pathArg.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/** Run contract file — always remapped to the run directory. */
export function isRunContractPath(pathArg: string): boolean {
  return exactRunArtifactRelPath(pathArg) === 'contract.md'
}

/** Run plan.md — remapped once the run artifact exists (the run seeds it at start). */
export function isRunPlanPath(pathArg: string): boolean {
  return exactRunArtifactRelPath(pathArg) === 'plan.md'
}

function autoModeSwitchEnabled(opts?: ModePolicyOptions): boolean {
  return opts?.autoModeSwitch === true
}

function autoModeSwitchBanner(mode: AgentInteractionMode, auto: boolean): string[] {
  if (!auto) {
    return [
      'Automatic mode switching is OFF. `switch_mode` is unavailable; only the user can change modes.'
    ]
  }
  switch (mode) {
    case 'agent':
      return [
        'Automatic mode switching is ON. Use `switch_mode` with `ask` for read-only Q&A. Planning needs no switch — `create_plan` publishes the plan and this same mode implements it.'
      ]
    case 'ask':
      return [
        'Automatic mode switching is ON. Use `switch_mode` with `agent` to plan or make changes.'
      ]
    default: {
      const _exhaustive: never = mode
      return _exhaustive
    }
  }
}

export function modeSectionMarkdown(
  mode: AgentInteractionMode,
  opts?: ModePolicyOptions
): string | null {
  const auto = autoModeSwitchEnabled(opts)
  switch (mode) {
    case 'agent':
      return wrapPromptSection(
        'mode',
        [
          'Agent mode. You may use the tools in this turn’s catalog, subject to their schemas and approval requirements.',
          ...autoModeSwitchBanner(mode, auto),
          // Plan mode's discipline, now unconditional: it was the only thing
          // that mode enforced that Agent did not already allow.
          'Plan before you act. Inspect the workspace with reads first so the plan names paths and symbols verified in this run, give every step a runnable check (a test, command, or output) instead of asserting success, then publish with `create_plan` — no mode change is needed to implement it.',
          'Follow the run contract and any approved plan unless the user redirects. Ask before making a product decision that materially changes the result.',
          ...(opts?.inlineInstance
            ? []
            : [
                'Root-only agent-instance tools may be available. Always prefer fan-out: every single time, no matter how small the request, plan first with `create_plan` (Goal, Steps, Done when) and decompose the plan into a structured set of very small, atomic, independent tasks (one verifiable deliverable each; split anything larger) — every plan step maps to one child agent instance. Fan every task out with a complete structured brief — outcome, sub-tasks, done-when, affected paths — since the child sees nothing of this conversation; you decide how many instances the decomposition needs, and the parent never finishes actionable work having spawned zero instances (it only makes the individual tool calls needed to plan, brief, and verify). Keep one task per instance so no child is overloaded; spawn all of them in one step and await them together in one step, and follow the catalog schemas for the spawn, await, and merge lifecycle. Batch independent tool calls within a step first. Briefs demand verified evidence — real file reads, command output, test results; a child reports anything unverified as unknown, never assumed, and the parent verifies each child’s summary before reporting success.',
                'Batch independent tool calls within a step first; whole workstreams go to child instances as small briefs rather than being executed step-by-step in the parent.'
              ])
        ].join('\n')
      )
    case 'ask':
      return wrapPromptSection(
        'mode',
        [
          'Ask mode. Answer and investigate with the read-only tools in this turn’s catalog.',
          'Do not edit or delete files, run commands with `terminal` or `diagnostics`, write memory, or invoke MCP server tools. MCP catalog listing remains available.',
          ...autoModeSwitchBanner(mode, auto),
          ...(auto
            ? []
            : ['If changes are required, explain that the user must switch to Agent mode.'])
        ].join('\n')
      )
    default: {
      const _exhaustive: never = mode
      return _exhaustive
    }
  }
}

export function isBuiltinAllowedInMode(
  mode: AgentInteractionMode,
  name: string,
  opts?: ModePolicyOptions
): boolean {
  if (name === 'switch_mode') return autoModeSwitchEnabled(opts)
  if (mode === 'agent') return true
  return ASK_SAFE_BUILTIN.has(name)
}

/**
 * MCP tools are Agent-mode only. Server-reported `readOnlyHint` is untrusted
 * as a security gate (see classify.ts) — never use it to allow Ask.
 */
export function isMcpAllowedInMode(mode: AgentInteractionMode, _fullName: string): boolean {
  return mode === 'agent'
}

export function filterToolDefsForMode<T extends { name: string }>(
  mode: AgentInteractionMode,
  defs: T[],
  opts?: ModePolicyOptions
): T[] {
  let filtered =
    mode === 'agent' && autoModeSwitchEnabled(opts)
      ? defs
      : defs.filter((t) => {
          if (parseMcpToolName(t.name)) return isMcpAllowedInMode(mode, t.name)
          return isBuiltinAllowedInMode(mode, t.name, opts)
        })
  if (opts?.inlineInstance) {
    filtered = filtered.filter((t) => !INLINE_OMIT_BUILTIN.has(t.name))
  }
  return filtered
}

/** Drop `codebase_search` / `concept_search` when Settings → Indexing is off. */
export function filterToolDefsForCodeIndex<T extends { name: string }>(
  defs: T[],
  codeIndexEnabled: boolean
): T[] {
  if (codeIndexEnabled) return defs
  return defs.filter((t) => t.name !== 'codebase_search' && t.name !== 'concept_search')
}

export type ModeDenyResult = { ok: true } | { ok: false; error: string }

/**
 * Hard gate before executing a tool. Agent admits everything in its catalog;
 * Ask admits only ASK_SAFE_BUILTIN, and never MCP.
 */
export function assertToolAllowedInMode(
  mode: AgentInteractionMode,
  name: string,
  args: Record<string, unknown>,
  opts?: ModePolicyOptions
): ModeDenyResult {
  const auto = autoModeSwitchEnabled(opts)
  const switchToAgentHint = auto
    ? 'Call `switch_mode` with mode "agent" first.'
    : 'Switch to Agent mode to make changes.'
  if (name === 'switch_mode' && !auto) {
    return {
      ok: false,
      error:
        'Automatic mode switching is off. Only the user can change Ask / Agent (composer or slash).'
    }
  }

  if (opts?.inlineInstance && INLINE_OMIT_BUILTIN.has(name)) {
    return {
      ok: false,
      error: `Tool "${name}" is only available on the root orchestrator (inline instances cannot nest).`
    }
  }

  if (AGENT_ONLY_BUILTIN.has(name) && mode !== 'agent') {
    return {
      ok: false,
      error: `Tool "${name}" requires Agent mode. ${switchToAgentHint}`
    }
  }

  if (mode === 'agent') return { ok: true }

  const mcp = parseMcpToolName(name)
  if (mcp) {
    if (!isMcpAllowedInMode(mode, name)) {
      return {
        ok: false,
        error: `Ask mode does not allow MCP tools. "${name}" requires Agent mode. ${switchToAgentHint}`
      }
    }
    return { ok: true }
  }

  if (!isBuiltinAllowedInMode(mode, name, opts)) {
    return {
      ok: false,
      error: `Ask mode does not allow tool "${name}". ${switchToAgentHint}`
    }
  }

  if (name === 'lsp' && lspActionFromArgs(args) === 'rename') {
    return {
      ok: false,
      error: `Ask mode does not allow lsp rename. ${switchToAgentHint}`
    }
  }

  if (name === 'browser_tabs' && args.action === 'close') {
    return {
      ok: false,
      error: `Ask mode does not allow browser_tabs close. ${switchToAgentHint}`
    }
  }

  return { ok: true }
}
