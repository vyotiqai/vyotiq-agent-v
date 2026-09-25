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
import { AGENT_ONLY_BUILTIN, INLINE_OMIT_BUILTIN } from '../../../src/main/agent/tools/classify'
import { BUILTIN_TOOL_NAMES, TOOL_REGISTRY } from '../../../src/main/agent/schemas/tools'
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

  it('Ask allows lsp reads and denies lsp rename and edit_notebook', () => {
    expect(isBuiltinAllowedInMode('ask', 'lsp')).toBe(true)
    expect(assertToolAllowedInMode('ask', 'lsp', { path: 'a.ts', action: 'hover' }).ok).toBe(true)
    expect(assertToolAllowedInMode('agent', 'lsp', { path: 'a.ts', action: 'diagnostics' }).ok).toBe(
      true
    )
    expect(
      assertToolAllowedInMode('ask', 'lsp', { path: 'a.ts', action: 'rename', new_name: 'y' }).ok
    ).toBe(false)
    expect(isBuiltinAllowedInMode('ask', 'edit_notebook')).toBe(false)
    expect(isBuiltinAllowedInMode('agent', 'edit_notebook')).toBe(true)
  })

  it('Ask denies browser_tabs close; Agent allows it', () => {
    const opts = { autoModeSwitch: true }
    expect(assertToolAllowedInMode('ask', 'browser_tabs', { action: 'close' }, opts).ok).toBe(false)
    expect(assertToolAllowedInMode('agent', 'browser_tabs', { action: 'close' }, opts).ok).toBe(true)
    expect(assertToolAllowedInMode('ask', 'browser_tabs', { action: 'list' }, opts).ok).toBe(true)
  })

  it('Agent allows update_goal complete — the Plan-mode block went with the mode', () => {
    const opts = { autoModeSwitch: true }
    expect(assertToolAllowedInMode('agent', 'update_goal', { status: 'complete' }, opts).ok).toBe(true)
    expect(assertToolAllowedInMode('agent', 'update_goal', { status: 'active' }, opts).ok).toBe(true)
    expect(assertToolAllowedInMode('ask', 'update_goal', { status: 'active' }, opts).ok).toBe(false)
  })

  it('Agent may edit product code and plan artifacts alike', () => {
    const opts = { autoModeSwitch: true }
    // Plan mode fenced edits to plan.md / contract.md. Agent never did, and it
    // is now the only mode that edits at all.
    expect(assertToolAllowedInMode('agent', 'edit', { path: 'src/app.ts', contents: 'x' }, opts).ok).toBe(
      true
    )
    expect(assertToolAllowedInMode('agent', 'str_replace', { path: 'plan.md' }, opts).ok).toBe(true)
  })

  it('browser_tabs without a close action stays allowed in Ask mode', () => {
    expect(assertToolAllowedInMode('ask', 'browser_tabs', {}, {}).ok).toBe(true)
  })

  it('Ask mode denies diagnostics, create_plan and terminal; Agent allows them', () => {
    expect(isBuiltinAllowedInMode('ask', 'diagnostics')).toBe(false)
    expect(isBuiltinAllowedInMode('agent', 'diagnostics')).toBe(true)
    expect(isBuiltinAllowedInMode('agent', 'create_plan')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'create_plan')).toBe(false)
    expect(assertToolAllowedInMode('ask', 'diagnostics', {}).ok).toBe(false)
    expect(assertToolAllowedInMode('agent', 'diagnostics', {}).ok).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'terminal')).toBe(false)
    expect(isBuiltinAllowedInMode('agent', 'terminal')).toBe(true)
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

  it('modeSectionMarkdown covers both surviving modes and names no third', () => {
    expect(modeSectionMarkdown('agent')).toContain('Agent mode')
    expect(modeSectionMarkdown('ask')).toContain('Ask mode')
    expect(modeSectionMarkdown('agent')).toMatch(/tools in this turn’s catalog/)
    expect(modeSectionMarkdown('agent')).not.toMatch(/Tool policy/)
    // Plan is merged in; no section may still advertise it as somewhere to go.
    expect(modeSectionMarkdown('agent')).not.toMatch(/Plan mode/)
    expect(modeSectionMarkdown('ask')).not.toMatch(/Plan mode/)
    expect(modeSectionMarkdown('agent', { autoModeSwitch: true })).not.toMatch(/`plan`/)
    expect(modeSectionMarkdown('ask', { autoModeSwitch: true })).not.toMatch(/`plan`/)
  })

  it('Agent carries the planning discipline Plan mode used to own', () => {
    const agent = modeSectionMarkdown('agent')!
    expect(agent).toMatch(/Plan before you act/)
    expect(agent).toMatch(/verified in this run/)
    expect(agent).toMatch(/runnable check/)
    expect(agent).toMatch(/`create_plan`/)
    // The whole point of the merge: publishing does not hand off to a mode.
    expect(agent).toMatch(/no mode change is needed to implement it/)
  })

  it('modeSectionMarkdown has no proactive switch_mode calls when autoModeSwitch is off', () => {
    expect(modeSectionMarkdown('agent')).toMatch(/Automatic mode switching is OFF/)
    expect(modeSectionMarkdown('ask')).toMatch(/Automatic mode switching is OFF/)
    expect(modeSectionMarkdown('agent')).not.toMatch(/call `switch_mode`/i)
    expect(modeSectionMarkdown('ask')).not.toMatch(/call `switch_mode`/i)
    expect(modeSectionMarkdown('ask')).toMatch(/must switch to Agent mode/)
  })

  it('modeSectionMarkdown includes proactive switch_mode rules when autoModeSwitch is on', () => {
    const opts = { autoModeSwitch: true }
    expect(modeSectionMarkdown('agent', opts)).toMatch(/Automatic mode switching is ON/)
    expect(modeSectionMarkdown('agent', opts)).toMatch(/switch_mode[\s\S]*`ask`/)
    expect(modeSectionMarkdown('ask', opts)).toMatch(/switch_mode[\s\S]*`agent`/)
    // Publishing a plan must not cost a `switch_mode` step in either direction:
    // the mode it used to hand off to and from is the mode the run is in.
    expect(modeSectionMarkdown('agent', opts)).toMatch(/Planning needs no switch/)
    expect(modeSectionMarkdown('agent', opts)).not.toMatch(/switches the run to `plan`/)
  })

  it('assertToolAllowedInMode deny text points at switch_mode when auto is on', () => {
    const auto = { autoModeSwitch: true }
    const denied = assertToolAllowedInMode('ask', 'edit', { path: 'a.ts' }, auto)
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.error).toMatch(/switch_mode/)
      expect(denied.error).toMatch(/agent/)
    }
    // Every remaining denial names Ask — no message may still say "Plan mode".
    for (const call of [
      ['edit', { path: 'src/app.ts', contents: 'x' }],
      ['lsp', { path: 'a.ts', action: 'rename', new_name: 'y' }],
      ['mcp__srv__tool', {}]
    ] as const) {
      const r = assertToolAllowedInMode('ask', call[0], call[1], auto)
      expect(r.ok, call[0]).toBe(false)
      if (!r.ok) {
        expect(r.error, call[0]).toMatch(/^Ask mode does not allow/)
        expect(r.error, call[0]).not.toMatch(/Plan/)
      }
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

  it('create_plan is allowed in Agent regardless of autoModeSwitch, and never in Ask', () => {
    const opts = { autoModeSwitch: true }
    expect(assertToolAllowedInMode('agent', 'create_plan', { title: 'Ship it' }, opts).ok).toBe(true)
    expect(assertToolAllowedInMode('agent', 'create_plan', { title: 'Ship it' }).ok).toBe(true)
    expect(
      assertToolAllowedInMode('agent', 'create_plan', { title: 'Ship it' }, {
        autoModeSwitch: false
      }).ok
    ).toBe(true)
    expect(assertToolAllowedInMode('ask', 'create_plan', { title: 'Ship it' }, opts).ok).toBe(false)
  })

  it('Ask forbids diagnostics and terminal', () => {
    const ask = modeSectionMarkdown('ask')!
    expect(ask).toMatch(/Do not edit or delete files/)
    expect(ask).toMatch(/`diagnostics`/)
    expect(ask).toMatch(/run commands/)
  })

  it('the canonical plan structure moved to the create_plan tool description', () => {
    // It used to live in the Plan-mode prompt section. Deleting that section
    // must not have dropped the structure on the floor — it is the only thing
    // telling the model what a publishable plan looks like.
    const desc = TOOL_REGISTRY.create_plan.description
    for (const heading of [
      '`## Goal`',
      '`## Scope`',
      '`## Architecture`',
      '```mermaid',
      '`## Steps`',
      '`## Done when`',
      '`## Risks`'
    ]) {
      expect(desc, heading).toContain(heading)
    }
    expect(desc).toMatch(/verified in this run/)
    expect(desc).toMatch(/runnable check/)
    // The old description claimed the opposite of what the handler now does.
    expect(desc).not.toMatch(/switches the run to Plan mode/)
    expect(desc).toMatch(/Publishing changes no mode/)
  })

  it('omits codebase_search and concept_search when indexing is disabled', () => {
    const defs = [
      { name: 'read' },
      { name: 'codebase_search' },
      { name: 'concept_search' },
      { name: 'grep' }
    ]
    expect(filterToolDefsForCodeIndex(defs, true).map((d) => d.name)).toEqual([
      'read',
      'codebase_search',
      'concept_search',
      'grep'
    ])
    expect(filterToolDefsForCodeIndex(defs, false).map((d) => d.name)).toEqual(['read', 'grep'])
  })

  it('classifies every built-in into Ask, instance-only, switch_mode, or Agent-only', () => {
    // These eight were Plan mode's additions over Ask. With Plan merged they
    // are plain Agent tools; the grouping is kept so the merge stays legible.
    const formerlyPlanExtra = [
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
      'edit_notebook',
      // Writing a module that later runs as arbitrary Node is neither a read
      // nor a planning step.
      'build_tool'
    ] as const

    const classified = [
      ...ASK_SAFE_BUILTIN,
      ...formerlyPlanExtra,
      ...AGENT_ONLY_BUILTIN,
      ...agentOnlyByOmission,
      'switch_mode'
    ]
    expect([...classified].sort()).toEqual([...BUILTIN_TOOL_NAMES].sort())
    expect(new Set(classified).size).toBe(BUILTIN_TOOL_NAMES.length)

    // Goal tools are omitted from inline child instances. Pin the coupling so
    // future edits can't silently change the set.
    expect(
      [...INLINE_OMIT_BUILTIN].filter((name) => !AGENT_ONLY_BUILTIN.has(name)).sort()
    ).toEqual(['create_goal', 'update_goal'])

    for (const name of ASK_SAFE_BUILTIN) {
      expect(isBuiltinAllowedInMode('ask', name), name).toBe(true)
      expect(isBuiltinAllowedInMode('agent', name), name).toBe(true)
    }
    for (const name of [
      ...formerlyPlanExtra,
      ...AGENT_ONLY_BUILTIN,
      ...agentOnlyByOmission
    ]) {
      expect(isBuiltinAllowedInMode('ask', name), name).toBe(false)
      expect(isBuiltinAllowedInMode('agent', name), name).toBe(true)
    }
    expect(isBuiltinAllowedInMode('ask', 'switch_mode')).toBe(false)
    expect(isBuiltinAllowedInMode('agent', 'switch_mode')).toBe(false)
    expect(isBuiltinAllowedInMode('agent', 'switch_mode', { autoModeSwitch: true })).toBe(true)
  })
})
