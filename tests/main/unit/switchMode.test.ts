import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import {
  assertToolAllowedInMode,
  filterToolDefsForMode,
  isBuiltinAllowedInMode
} from '@main/agent/tools/modePolicy'
import { AGENT_TOOLS } from '@main/agent/schemas/tools'
import { isApprovalExemptTool, isParallelSafeTool } from '@main/agent/tools/classify'
const getSettings = vi.hoisted(() =>
  vi.fn(() => ({ ...DEFAULT_SETTINGS, autoModeSwitch: true }))
)

vi.mock('@main/settings/settings', () => ({
  getSettings: () => getSettings()
}))

import { executeTool } from '@main/agent/tools'

describe('switch_mode', () => {
  beforeEach(() => {
    getSettings.mockReset()
    getSettings.mockReturnValue({ ...DEFAULT_SETTINGS, autoModeSwitch: true })
  })

  it('is allowed in every interaction mode when autoModeSwitch is on', () => {
    const opts = { autoModeSwitch: true }
    expect(isBuiltinAllowedInMode('ask', 'switch_mode', opts)).toBe(true)
    expect(isBuiltinAllowedInMode('plan', 'switch_mode', opts)).toBe(true)
    expect(isBuiltinAllowedInMode('agent', 'switch_mode', opts)).toBe(true)
    expect(assertToolAllowedInMode('ask', 'switch_mode', { mode: 'agent' }, opts).ok).toBe(true)
    expect(assertToolAllowedInMode('plan', 'switch_mode', { mode: 'agent' }, opts).ok).toBe(true)
    expect(assertToolAllowedInMode('agent', 'switch_mode', { mode: 'plan' }, opts).ok).toBe(true)
  })

  it('is denied in every interaction mode when autoModeSwitch is off', () => {
    expect(isBuiltinAllowedInMode('ask', 'switch_mode')).toBe(false)
    expect(isBuiltinAllowedInMode('plan', 'switch_mode', { autoModeSwitch: false })).toBe(false)
    expect(isBuiltinAllowedInMode('agent', 'switch_mode', { autoModeSwitch: false })).toBe(false)
    const denied = assertToolAllowedInMode(
      'agent',
      'switch_mode',
      { mode: 'plan' },
      { autoModeSwitch: false }
    )
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.error).toMatch(/Automatic mode switching is off/i)
      expect(denied.error).toMatch(/Only the user can change/i)
    }
  })

  it('is serial and approval-exempt', () => {
    expect(isParallelSafeTool('switch_mode')).toBe(false)
    expect(isApprovalExemptTool('switch_mode')).toBe(true)
    expect(isParallelSafeTool('ask_question')).toBe(false)
    expect(isApprovalExemptTool('ask_question')).toBe(true)
  })

  it('updates mutable mode and emits mode_changed when autoModeSwitch is on', async () => {
    let mode: 'ask' | 'plan' | 'agent' = 'ask'
    const events: { type: string; mode?: string }[] = []
    const result = await executeTool(
      'switch_mode',
      JSON.stringify({ mode: 'agent' }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        getAgentMode: () => mode,
        setAgentMode: (next) => {
          mode = next
        },
        emitAgentEvent: (ev) => events.push(ev),
        autoModeSwitch: true
      }
    )
    expect(result.ok).toBe(true)
    expect(mode).toBe('agent')
    expect(events[0]?.type).toBe('mode_changed')
    expect(events[0]).toMatchObject({ type: 'mode_changed', runId: 'run-1', mode: 'agent' })
  })

  it('fails execute when setAgentMode is not wired', async () => {
    const events: { type: string; mode?: string }[] = []
    const result = await executeTool(
      'switch_mode',
      JSON.stringify({ mode: 'agent' }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        getAgentMode: () => 'ask',
        emitAgentEvent: (ev) => events.push(ev),
        autoModeSwitch: true
      }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/setAgentMode is not wired/i)
    expect(events).toHaveLength(0)
  })

  it('fails execute when autoModeSwitch is off', async () => {
    getSettings.mockReturnValue({ ...DEFAULT_SETTINGS, autoModeSwitch: false })
    let mode: 'ask' | 'plan' | 'agent' = 'ask'
    const result = await executeTool(
      'switch_mode',
      JSON.stringify({ mode: 'agent' }),
      '/ws',
      new AbortController().signal,
      {
        runId: 'run-1',
        toolCallId: 'tc-1',
        getAgentMode: () => mode,
        setAgentMode: (next) => {
          mode = next
        },
        autoModeSwitch: false
      }
    )
    expect(result.ok).toBe(false)
    expect(mode).toBe('ask')
    expect(result.content).toMatch(/Automatic mode switching is off/i)
  })

  it('re-filters tool defs after mode change when autoModeSwitch is on', () => {
    const opts = { autoModeSwitch: true }
    const askTools = filterToolDefsForMode('ask', AGENT_TOOLS, opts).map((t) => t.name)
    expect(askTools).toContain('ask_question')
    expect(askTools).toContain('switch_mode')
    expect(askTools).not.toContain('edit')
    expect(askTools).not.toContain('compact_context')

    const agentTools = filterToolDefsForMode('agent', AGENT_TOOLS, opts).map((t) => t.name)
    expect(agentTools).toContain('edit')
    expect(agentTools).toContain('ask_question')
    expect(agentTools).toContain('switch_mode')
    expect(agentTools).not.toContain('compact_context')
  })

  it('omits switch_mode from tool defs when autoModeSwitch is off', () => {
    const askTools = filterToolDefsForMode('ask', AGENT_TOOLS).map((t) => t.name)
    expect(askTools).not.toContain('switch_mode')
    const agentTools = filterToolDefsForMode('agent', AGENT_TOOLS, {
      autoModeSwitch: false
    }).map((t) => t.name)
    expect(agentTools).not.toContain('switch_mode')
    expect(agentTools).toContain('edit')
  })

  it('seeds plan.md when switching to plan', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-switch-plan-'))
    const runDir = join(workspace, 'run')
    mkdirSync(runDir)
    try {
      let mode: 'ask' | 'plan' | 'agent' = 'ask'
      const result = await executeTool(
        'switch_mode',
        JSON.stringify({ mode: 'plan' }),
        workspace,
        new AbortController().signal,
        {
          runId: 'run-plan-seed',
          runDir,
          getAgentMode: () => mode,
          setAgentMode: (next) => {
            mode = next
          },
          autoModeSwitch: true
        }
      )
      expect(result.ok).toBe(true)
      expect(mode).toBe('plan')
      expect(existsSync(join(runDir, 'plan.md'))).toBe(true)
      expect(readFileSync(join(runDir, 'plan.md'), 'utf8')).toContain('## Steps')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('create_plan switches the run to plan mode and publishes when autoModeSwitch is on', async () => {
    const plan = [
      '## Goal',
      '',
      'Prove the create_plan mode contract end to end through executeTool.',
      '',
      '## Steps',
      '',
      '1. Call `create_plan` in Agent mode and verify the run switches to Plan mode.',
      '',
      '## Done when',
      '',
      '- [ ] The targeted vitest run is green.'
    ].join('\n')
    const argsJson = JSON.stringify({ title: 'Ship the planner', plan })
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-create-plan-gate-'))
    const runDir = join(workspace, 'run')
    mkdirSync(runDir)
    try {
      let mode: 'ask' | 'plan' | 'agent' = 'agent'
      const events: { type: string; mode?: string }[] = []
      const result = await executeTool('create_plan', argsJson, workspace, new AbortController().signal, {
        runId: 'gate-run-agent',
        runDir,
        invokeId: 7,
        getAgentMode: () => mode,
        setAgentMode: (next) => {
          mode = next
        },
        emitAgentEvent: (ev) => events.push(ev),
        autoModeSwitch: true
      })
      expect(result.ok).toBe(true)
      expect(mode).toBe('plan')
      expect(events).toEqual([
        { type: 'mode_changed', runId: 'gate-run-agent', mode: 'plan', invokeId: 7 }
      ])
      expect(result.content).toMatch(/Switched to Plan mode/)
      expect(existsSync(join(runDir, 'plan.md'))).toBe(true)

      // Already in plan mode: publishes without a redundant switch.
      const planEvents: { type: string }[] = []
      const again = await executeTool('create_plan', argsJson, workspace, new AbortController().signal, {
        runId: 'gate-run-plan',
        runDir,
        getAgentMode: () => 'plan',
        emitAgentEvent: (ev) => planEvents.push(ev),
        autoModeSwitch: true
      })
      expect(again.ok).toBe(true)
      expect(planEvents).toHaveLength(0)

      // Auto off: publishes in agent mode without switching.
      let autoOffMode: 'ask' | 'plan' | 'agent' = 'agent'
      const autoOffEvents: { type: string }[] = []
      const autoOff = await executeTool('create_plan', argsJson, workspace, new AbortController().signal, {
        runId: 'gate-run-autooff',
        runDir,
        getAgentMode: () => autoOffMode,
        setAgentMode: (next) => {
          autoOffMode = next
        },
        emitAgentEvent: (ev) => autoOffEvents.push(ev),
        autoModeSwitch: false
      })
      expect(autoOff.ok).toBe(true)
      expect(autoOffMode).toBe('agent')
      expect(autoOffEvents).toHaveLength(0)
      expect(autoOff.content).not.toMatch(/Switched to Plan mode/)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
