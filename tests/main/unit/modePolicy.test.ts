import { describe, expect, it, beforeEach } from 'vitest'
import {
  ASK_SAFE_BUILTIN,
  assertToolAllowedInMode,
  filterToolDefsForMode,
  filterToolDefsForCodeIndex,
  isBuiltinAllowedInMode,
  isPlanArtifactPath,
  isRunContractPath,
  isRunPlanPath,
  modeSectionMarkdown
} from '../../../src/main/agent/tools/modePolicy'
import { AGENT_ONLY_BUILTIN } from '../../../src/main/agent/tools/classify'
import { BUILTIN_TOOL_NAMES } from '../../../src/main/agent/schemas/tools'
import { setMcpReadOnlyHintsForTests } from '../../../src/main/agent/mcp'

describe('modePolicy', () => {
  beforeEach(() => {
    setMcpReadOnlyHintsForTests({ 'mcp__srv__tool': false })
  })

  it('Ask mode denies edit and terminal', () => {
    expect(isBuiltinAllowedInMode('ask', 'edit')).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'terminal')).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'read')).toBe(true)
    expect(assertToolAllowedInMode('ask', 'edit', { path: 'a.ts', contents: 'x' }).ok).toBe(false)
  })

  it('Agent mode allows all built-ins', () => {
    expect(isBuiltinAllowedInMode('agent', 'edit')).toBe(true)
    expect(isBuiltinAllowedInMode('agent', 'terminal')).toBe(true)
    expect(assertToolAllowedInMode('agent', 'delete', { path: 'x' }).ok).toBe(true)
  })

  it('inline instances omit root-only spawn/await/pull/merge tools even in Agent mode', () => {
    const defs = [
      { name: 'read' },
      { name: 'spawn_agent_instance' },
      { name: 'await_agent_instance' },
      { name: 'pull_agent_instance' },
      { name: 'merge_agent_instance' },
      { name: 'create_goal' },
      { name: 'update_goal' },
      { name: 'edit' }
    ]
    const filtered = filterToolDefsForMode('agent', defs, {
      autoModeSwitch: true,
      inlineInstance: true
    })
    expect(filtered.map((d) => d.name).sort()).toEqual(['edit', 'read'])
    expect(
      assertToolAllowedInMode('agent', 'spawn_agent_instance', { goal: 'x' }, { inlineInstance: true })
        .ok
    ).toBe(false)
    expect(assertToolAllowedInMode('agent', 'create_goal', { objective: 'x' }, { inlineInstance: true }).ok).toBe(
      false
    )
  })

  it('root Agent mode delegates instance details to tool schemas', () => {
    const section = modeSectionMarkdown('agent')
    expect(section).toMatch(/Root-only agent-instance tools/)
    expect(section).toMatch(/catalog schemas/)
    expect(section).not.toMatch(/spawn_agent_instance/)
    expect(section).not.toMatch(/path_scope/)
  })

  it('root Agent mode section carries the delegation decision policy', () => {
    const section = modeSectionMarkdown('agent')
    expect(section).toMatch(/every plan step maps to one child agent instance/)
    expect(section).toMatch(/decompose the plan into a structured set/)
    expect(section).toMatch(/one task per instance/)
    expect(section).toMatch(/every single time/i)
    expect(section).toMatch(/no matter how small the request/)
    expect(section).toMatch(/spawned zero instances/)
    expect(section).toMatch(/complete structured brief/)
    expect(section).toMatch(/child sees nothing of this conversation/)
    expect(section).toMatch(/spawn, await, and merge lifecycle/)
    expect(section).toMatch(/batch independent tool calls within a step first/i)
    expect(section).not.toMatch(/path_scope/)
  })

  it('inline instance Agent mode section omits delegation policy (parent-only)', () => {
    const section = modeSectionMarkdown('agent', { inlineInstance: true })
    expect(section).not.toMatch(/every plan step maps to one child agent instance/)
    expect(section).not.toMatch(/child sees nothing of this conversation/)
    expect(section).not.toMatch(/spawn_agent_instance/)
    expect(section).not.toMatch(/merge_agent_instance/)
  })

  it('inline instance Agent mode section omits spawn/merge instructions', () => {
    const section = modeSectionMarkdown('agent', { inlineInstance: true })
    expect(section).not.toMatch(/spawn_agent_instance/)
    expect(section).not.toMatch(/merge_agent_instance/)
  })

  it('isPlanArtifactPath recognizes plan and contract', () => {
    expect(isPlanArtifactPath('plan.md')).toBe(true)
    expect(isPlanArtifactPath('./contract.md')).toBe(true)
    expect(isPlanArtifactPath('src/plan.md')).toBe(true)
    expect(isPlanArtifactPath('src/app.ts')).toBe(false)
    expect(isPlanArtifactPath('.hermes/plans/2026-08-30_090537-agent-fixes.md')).toBe(false)
    expect(isPlanArtifactPath('.hermes/plans/x.md')).toBe(false)
    expect(isPlanArtifactPath('.hermes/plans/sub/deep.md')).toBe(false)
    expect(isPlanArtifactPath('.hermes/notes.md')).toBe(false)
  })

  it('isRunContractPath matches only the run-root contract.md', () => {
    expect(isRunContractPath('contract.md')).toBe(true)
    expect(isRunContractPath('./contract.md')).toBe(true)
    expect(isRunContractPath('plan.md')).toBe(false)
    expect(isRunContractPath('src/app.ts')).toBe(false)
    expect(isRunContractPath('src/contract.md')).toBe(false)
    expect(isRunPlanPath('plan.md')).toBe(true)
    expect(isRunPlanPath('./plan.md')).toBe(true)
    expect(isRunPlanPath('docs/plan.md')).toBe(false)
  })

  it('filterToolDefsForMode drops all MCP tools in Ask/Plan', () => {
    const defs = [
      { name: 'read' },
      { name: 'edit' },
      { name: 'mcp__srv__tool' },
      { name: 'mcp__srv__write' },
      { name: 'browser_click' },
      { name: 'browser_navigate' }
    ]
    setMcpReadOnlyHintsForTests({ 'mcp__srv__tool': true, 'mcp__srv__write': false })
    const ask = filterToolDefsForMode('ask', defs)
    expect(ask.map((d) => d.name)).toEqual(['read', 'browser_navigate'])
    expect(assertToolAllowedInMode('ask', 'mcp__srv__tool', {}).ok).toBe(false)
    expect(assertToolAllowedInMode('ask', 'mcp__srv__write', {}).ok).toBe(false)
    expect(assertToolAllowedInMode('agent', 'mcp__srv__tool', {}).ok).toBe(true)
  })

  it('Ask mode denies browser_click and browser_type', () => {
    expect(isBuiltinAllowedInMode('ask', 'browser_click')).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'browser_type')).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'browser_navigate')).toBe(true)
    expect(assertToolAllowedInMode('ask', 'browser_click', { selector: 'button' }).ok).toBe(false)
  })

  it('Ask mode denies browser_fill', () => {
    expect(isBuiltinAllowedInMode('ask', 'browser_fill')).toBe(false)
    expect(assertToolAllowedInMode('ask', 'browser_fill', { selector: 'input', value: 'x' }).ok).toBe(
      false
    )
  })

  it('Ask and Plan allow lsp reads and deny lsp rename and edit_notebook', () => {
    expect(isBuiltinAllowedInMode('ask', 'lsp')).toBe(true)
    expect(isBuiltinAllowedInMode('plan', 'lsp')).toBe(true)
    expect(assertToolAllowedInMode('ask', 'lsp', { path: 'a.ts', action: 'hover' }).ok).toBe(true)
    expect(assertToolAllowedInMode('plan', 'lsp', { path: 'a.ts', action: 'diagnostics' }).ok).toBe(
      true
    )
    expect(
      assertToolAllowedInMode('ask', 'lsp', { path: 'a.ts', action: 'rename', new_name: 'y' }).ok
    ).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'edit_notebook')).toBe(false)
    expect(isBuiltinAllowedInMode('plan', 'edit_notebook')).toBe(false)
  })

  it('Ask mode denies diagnostics and terminal; Plan allows diagnostics', () => {
    expect(isBuiltinAllowedInMode('ask', 'diagnostics')).toBe(false)
    expect(isBuiltinAllowedInMode('plan', 'diagnostics')).toBe(true)
    expect(isBuiltinAllowedInMode('plan', 'create_plan')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'create_plan')).toBe(false)
    expect(assertToolAllowedInMode('ask', 'diagnostics', {}).ok).toBe(false)
    expect(assertToolAllowedInMode('plan', 'diagnostics', {}).ok).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'terminal')).toBe(false)
    expect(isBuiltinAllowedInMode('plan', 'terminal')).toBe(false)
  })

  it('Ask mode allows wait/history/tabs and denies press_key/select_option', () => {
    expect(isBuiltinAllowedInMode('ask', 'browser_tabs')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'browser_back')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'browser_forward')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'browser_wait_for_selector')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'browser_wait_for_url')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'browser_wait_for_text')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'browser_hover')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'browser_handle_dialog')).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'mcp_list_tools')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'mcp_list_resources')).toBe(true)
    // Catalog listing only — read_resource/get_prompt stay Agent-only (untrusted server content).
    expect(isBuiltinAllowedInMode('ask', 'mcp_read_resource')).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'browser_press_key')).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'browser_select_option')).toBe(false)
  })

  it('modeSectionMarkdown covers all modes', () => {
    expect(modeSectionMarkdown('agent')).toContain('Agent mode')
    expect(modeSectionMarkdown('ask')).toContain('Ask mode')
    expect(modeSectionMarkdown('plan')).toContain('Plan mode')
    expect(modeSectionMarkdown('agent')).toMatch(/tools in this turn’s catalog/)
    expect(modeSectionMarkdown('agent')).not.toMatch(/Tool policy/)
    expect(modeSectionMarkdown('plan')).not.toMatch(/Keep\/Discard/i)
  })

  it('modeSectionMarkdown has no proactive switch_mode calls when autoModeSwitch is off', () => {
    expect(modeSectionMarkdown('agent')).toMatch(/Automatic mode switching is OFF/)
    expect(modeSectionMarkdown('ask')).toMatch(/Automatic mode switching is OFF/)
    expect(modeSectionMarkdown('plan')).toMatch(/Automatic mode switching is OFF/)
    expect(modeSectionMarkdown('agent')).not.toMatch(/call `switch_mode`/i)
    expect(modeSectionMarkdown('ask')).not.toMatch(/call `switch_mode`/i)
    expect(modeSectionMarkdown('plan')).not.toMatch(/call `switch_mode`/i)
    expect(modeSectionMarkdown('ask')).toMatch(/must switch to Agent mode/)
    expect(modeSectionMarkdown('plan')).toMatch(/switching to Agent mode/)
    expect(modeSectionMarkdown('plan')).not.toMatch(/End with a clear plan/)
    expect(modeSectionMarkdown('plan')).toMatch(/create_plan/)
  })

  it('modeSectionMarkdown includes proactive switch_mode rules when autoModeSwitch is on', () => {
    const opts = { autoModeSwitch: true }
    expect(modeSectionMarkdown('agent', opts)).toMatch(/Automatic mode switching is ON/)
    expect(modeSectionMarkdown('agent', opts)).toMatch(/switch_mode[\s\S]*`ask`/)
    expect(modeSectionMarkdown('agent', opts)).toMatch(/switch_mode[\s\S]*`plan`/)
    expect(modeSectionMarkdown('agent', opts)).toMatch(
      /calling `create_plan` switches the run to `plan` mode/
    )
    expect(modeSectionMarkdown('ask', opts)).toMatch(/switch_mode[\s\S]*`plan`/)
    expect(modeSectionMarkdown('ask', opts)).toMatch(/switch_mode[\s\S]*`agent`/)
    expect(modeSectionMarkdown('plan', opts)).toMatch(/switch_mode[\s\S]*`agent`/)
    expect(modeSectionMarkdown('plan', opts)).toMatch(/switch_mode[\s\S]*`ask`/)
    expect(modeSectionMarkdown('plan', opts)).not.toMatch(/suggest switching to Agent mode/)
  })

  it('assertToolAllowedInMode deny text points at switch_mode when auto is on', () => {
    const auto = { autoModeSwitch: true }
    const denied = assertToolAllowedInMode('ask', 'edit', { path: 'a.ts' }, auto)
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.error).toMatch(/switch_mode/)
      expect(denied.error).toMatch(/agent/)
    }
    const planDenied = assertToolAllowedInMode(
      'plan',
      'edit',
      { path: 'src/app.ts', contents: 'x' },
      auto
    )
    expect(planDenied.ok).toBe(false)
    if (!planDenied.ok) {
      expect(planDenied.error).toMatch(/switch_mode/)
    }
  })

  it('assertToolAllowedInMode deny text is user-facing when auto is off', () => {
    const denied = assertToolAllowedInMode('ask', 'edit', { path: 'a.ts' }, {
      autoModeSwitch: false
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.error).toMatch(/Switch to Agent mode/)
      expect(denied.error).not.toMatch(/switch_mode/)
    }
  })

  it('create_plan is allowed in every mode; the handler performs the switch', () => {
    const opts = { autoModeSwitch: true }
    expect(assertToolAllowedInMode('agent', 'create_plan', { title: 'Ship it' }, opts).ok).toBe(true)
    // Auto off: user controls modes manually — create_plan in agent stays allowed.
    expect(assertToolAllowedInMode('agent', 'create_plan', { title: 'Ship it' }).ok).toBe(true)
    expect(
      assertToolAllowedInMode('agent', 'create_plan', { title: 'Ship it' }, {
        autoModeSwitch: false
      }).ok
    ).toBe(true)
    expect(assertToolAllowedInMode('plan', 'create_plan', { title: 'Ship it' }, opts).ok).toBe(true)
  })

  it('Ask forbids diagnostics and terminal; Plan allows diagnostics', () => {
    const ask = modeSectionMarkdown('ask')!
    const plan = modeSectionMarkdown('plan')!
    expect(ask).toMatch(/Do not edit or delete files/)
    expect(ask).toMatch(/`diagnostics`/)
    expect(ask).toMatch(/run commands/)
    expect(plan).toMatch(/`create_plan`/)
    expect(plan).toMatch(/`diagnostics` and `run_tests` may run checks/)
    expect(plan).toMatch(/`terminal`/)
    expect(plan).toMatch(/`## Goal`/)
    expect(plan).toMatch(/`## Scope`/)
    expect(plan).toMatch(/`## Architecture`/)
    expect(plan).toMatch(/```mermaid/)
    expect(plan).toMatch(/`## Steps`/)
    expect(plan).toMatch(/`## Done when`/)
    expect(plan).toMatch(/`## Risks`/)
    expect(plan).toMatch(/verified in this run/)
  })

  it('omits codebase_search when indexing is disabled', () => {
    const defs = [{ name: 'read' }, { name: 'codebase_search' }, { name: 'grep' }]
    expect(filterToolDefsForCodeIndex(defs, true).map((d) => d.name)).toEqual([
      'read',
      'codebase_search',
      'grep'
    ])
    expect(filterToolDefsForCodeIndex(defs, false).map((d) => d.name)).toEqual(['read', 'grep'])
  })

  it('classifies every built-in into Ask, Plan-extra, instance-only, switch_mode, or Agent-only', () => {
    const planExtra = [
      'todo_write',
      'create_plan',
      'create_goal',
      'update_goal',
      'edit',
      'str_replace',
      'diagnostics',
      'run_tests'
    ] as const
    const agentOnlyByOmission = [
      'delete',
      'browser_click',
      'browser_type',
      'browser_fill',
      'browser_press_key',
      'browser_select_option',
      'browser_handle_dialog',
      'request_mcp_tools',
      'release_mcp_tools',
      'mcp_read_resource',
      'mcp_get_prompt',
      'terminal',
      'memory_write',
      'git_commit',
      'git_apply',
      'github_pr_create',
      'github_pr_review',
      'github_issue',
      'edit_notebook'
    ] as const

    const classified = [
      ...ASK_SAFE_BUILTIN,
      ...planExtra,
      ...AGENT_ONLY_BUILTIN,
      ...agentOnlyByOmission,
      'switch_mode'
    ]
    expect([...classified].sort()).toEqual([...BUILTIN_TOOL_NAMES].sort())
    expect(new Set(classified).size).toBe(BUILTIN_TOOL_NAMES.length)

    for (const name of ASK_SAFE_BUILTIN) {
      expect(isBuiltinAllowedInMode('ask', name), name).toBe(true)
      expect(isBuiltinAllowedInMode('plan', name), name).toBe(true)
    }
    for (const name of planExtra) {
      expect(isBuiltinAllowedInMode('ask', name), name).toBe(false)
      expect(isBuiltinAllowedInMode('plan', name), name).toBe(true)
    }
    for (const name of [...AGENT_ONLY_BUILTIN, ...agentOnlyByOmission]) {
      expect(isBuiltinAllowedInMode('ask', name), name).toBe(false)
      expect(isBuiltinAllowedInMode('plan', name), name).toBe(false)
      expect(isBuiltinAllowedInMode('agent', name), name).toBe(true)
    }
    expect(isBuiltinAllowedInMode('ask', 'switch_mode')).toBe(false)
    expect(isBuiltinAllowedInMode('plan', 'switch_mode')).toBe(false)
    expect(isBuiltinAllowedInMode('agent', 'switch_mode')).toBe(false)
    expect(isBuiltinAllowedInMode('agent', 'switch_mode', { autoModeSwitch: true })).toBe(true)
  })
})
