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
  // `diagnostics` spawns a shell — Plan-only (see PLAN_EXTRA / agent), not Ask.
])

/** Plan mode also allows todos + plan-artifact edits + diagnostics. */
const PLAN_EXTRA_BUILTIN = new Set([
  'todo_write',
  'create_plan',
  'create_goal',
  'update_goal',
  'edit',
  'str_replace',
  'diagnostics',
  'run_tests'
])

/** Filenames Plan mode may write inside the run directory. */
export const PLAN_ARTIFACT_NAMES = new Set(['contract.md', 'plan.md'])

export function isPlanArtifactPath(pathArg: string): boolean {
  const p = pathArg.replace(/\\/g, '/').replace(/^\.\//, '')
  return PLAN_ARTIFACT_NAMES.has(basename(p))
}

/** Workspace-relative path with `./` stripped — not nested `src/contract.md`. */
function exactRunArtifactRelPath(pathArg: string): string {
  return pathArg.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/** Run contract file — remapped to the run directory in Plan and Agent modes. */
export function isRunContractPath(pathArg: string): boolean {
  return exactRunArtifactRelPath(pathArg) === 'contract.md'
}

/** Run plan.md — remapped in Plan always; in Agent when a run plan artifact exists. */
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
        'Automatic mode switching is ON. Use `switch_mode` when the task changes to read-only Q&A (`ask`); calling `create_plan` switches the run to `plan` mode — switch back to `agent` to implement.'
      ]
    case 'ask':
      return [
        'Automatic mode switching is ON. Use `switch_mode` before planning (`plan`) or making changes (`agent`).'
      ]
    case 'plan':
      return [
        'Automatic mode switching is ON. Use `switch_mode` before implementation (`agent`) or read-only Q&A (`ask`).'
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
    case 'plan':
      return wrapPromptSection(
        'mode',
        [
          'Plan mode. Inspect the workspace with read-only tools before drafting. Plans must name paths and symbols verified in this run.',
          'Use `ask_question` for blocking choices, then publish the complete plan with `create_plan`. Follow the canonical structure: `## Goal` (outcome in 1–2 sentences), `## Scope` (in / out), `## Architecture` (a ```mermaid diagram of the affected components and data flow, with nodes named after real files or symbols), `## Steps` (ordered; each step names the paths or symbols it touches — verified in this run — and the runnable check that proves it done: a test, command, or output), `## Done when` (a `- [ ]` checklist of concrete, observable criteria), `## Risks` (trade-offs, unknowns).',
          'Give the run a check it can execute (tests, build, lint) and cite real evidence — test output or command results — rather than asserting success.',
          'Only plan.md and contract.md may be edited. Do not change product files, delete files, run `terminal`, write memory, or invoke MCP server tools. `diagnostics` and `run_tests` may run checks subject to approval.',
          ...autoModeSwitchBanner(mode, auto),
          ...(auto
            ? []
            : ['After the plan is ready, the user can approve implementation by switching to Agent mode.'])
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
  if (ASK_SAFE_BUILTIN.has(name)) return true
  if (mode === 'plan' && PLAN_EXTRA_BUILTIN.has(name)) return true
  return false
}

/**
 * MCP tools are Agent-mode only. Server-reported `readOnlyHint` is untrusted
 * as a security gate (see classify.ts) — never use it to allow Ask/Plan.
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

/** Drop `codebase_search` when Settings → Indexing is off. */
export function filterToolDefsForCodeIndex<T extends { name: string }>(
  defs: T[],
  codeIndexEnabled: boolean
): T[] {
  if (codeIndexEnabled) return defs
  return defs.filter((t) => t.name !== 'codebase_search')
}

export type ModeDenyResult = { ok: true } | { ok: false; error: string }

/**
 * Hard gate before executing a tool. Plan edit/str_replace must target plan artifacts.
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
        'Automatic mode switching is off. Only the user can change Ask / Plan / Agent (composer or slash).'
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
        error: `${mode === 'ask' ? 'Ask' : 'Plan'} mode does not allow MCP tools. "${name}" requires Agent mode. ${switchToAgentHint}`
      }
    }
    return { ok: true }
  }

  if (!isBuiltinAllowedInMode(mode, name, opts)) {
    return {
      ok: false,
      error: `${mode === 'ask' ? 'Ask' : 'Plan'} mode does not allow tool "${name}". ${switchToAgentHint}`
    }
  }

  if (name === 'lsp' && lspActionFromArgs(args) === 'rename') {
    return {
      ok: false,
      error: `${mode === 'ask' ? 'Ask' : 'Plan'} mode does not allow lsp rename. ${switchToAgentHint}`
    }
  }

  if (name === 'browser_tabs' && args.action === 'close') {
    return {
      ok: false,
      error: `${mode === 'ask' ? 'Ask' : 'Plan'} mode does not allow browser_tabs close. ${switchToAgentHint}`
    }
  }

  if (mode === 'plan' && name === 'update_goal' && args.status === 'complete') {
    return {
      ok: false,
      error: `Plan mode does not allow update_goal "complete". ${switchToAgentHint}`
    }
  }

  if (mode === 'plan' && (name === 'edit' || name === 'str_replace')) {
    const path = typeof args.path === 'string' ? args.path : ''
    if (!isPlanArtifactPath(path)) {
      return {
        ok: false,
        error: auto
          ? 'Plan mode may only edit plan.md or contract.md (run plan artifacts). Call `switch_mode` with mode "agent" to edit product code.'
          : 'Plan mode may only edit plan.md or contract.md (run plan artifacts). Switch to Agent mode to edit product code.'
      }
    }
  }

  return { ok: true }
}
