import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assembleContext } from '@main/agent/context/assemble'
import { KEEP_LAST_TOOL_RESULTS } from '@main/agent/context/types'
import { shouldTriggerAutoCompact } from '@main/agent/context/estimate'
import { clearRulesCache } from '@main/agent/context/rules'
import { clearWorkspaceSnapshotCache } from '@main/agent/context/workspaceSnapshot'
import { volatileSessionMessage } from '@main/agent/providers/systemZones'
import type { LlmProvider } from '@main/agent/providers/types'
import { contentToText } from '@shared/ipc'
import { SKILL_BODY_STUB } from '@shared/slashCommands'

const mockProvider: LlmProvider = {
  id: 'ollama',
  listModels: async () => [],
  streamChat: async function* () {
    yield { type: 'done' }
  }
}

const model = {
  id: 'test',
  inputModalities: ['text'] as const,
  outputModalities: ['text'] as const,
  supportsTools: true,
  supportsVision: false,
  contextWindow: 100_000
}

describe('assembleContext integration', () => {
  it('injects contract and harness into system prompt', async () => {
    const result = await assembleContext({
      harness: '## Context\nAgent',
      contract: '## Goal\nBuild feature',
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: null,
      goal: 'hello',
      model,
      toolsJsonEstimate: 100,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    expect(result.system).toContain('## Context')
    expect(result.system).toContain('<run_contract>')
    expect(result.system).toContain('Build feature')
    expect(result.systemStable).toContain('## Context')
    expect(result.systemStable).toContain('Build feature')
    expect(result.system).toBe(
      result.systemVolatile
        ? `${result.systemStable}\n\n${result.systemVolatile}`
        : result.systemStable
    )
  })

  it('elides stale ephemeral tool results once history crosses the compaction trigger', async () => {
    // Prose tokens (BPE ~1 token per word) so the estimate reliably crosses the
    // 0.55 × content-window trigger of the small model window.
    const body = 'lorem ipsum dolor sit amet '.repeat(230)
    const toolResults = Array.from({ length: KEEP_LAST_TOOL_RESULTS + 2 }, (_, i) => ({
      role: 'tool' as const,
      toolName: 'read_file',
      toolCallId: `t${i}`,
      content: `RESULT-${i}:${body}`
    }))
    const result = await assembleContext({
      harness: 'harness',
      messages: [{ role: 'user', content: 'go' }, ...toolResults],
      workspacePath: null,
      goal: 'go',
      model: { ...model, contextWindow: 8_000 },
      toolsJsonEstimate: 50,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    const tools = result.messages.filter((m) => m.role === 'tool')
    expect(tools).toHaveLength(KEEP_LAST_TOOL_RESULTS + 2)
    for (let i = 0; i < tools.length; i++) {
      const text = contentToText(tools[i]!.content)
      if (i < tools.length - KEEP_LAST_TOOL_RESULTS) expect(text).toBe('[cleared]')
      else expect(text).toBe(`RESULT-${i}:${body}`)
    }
  })

  it('preserves prior compaction in system prompt', async () => {
    const result = await assembleContext({
      harness: 'harness',
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: null,
      goal: 'hi',
      model,
      toolsJsonEstimate: 50,
      sessionEnv: '<session>\nDate (UTC): 2026-08-16T12:00:00.000Z',
      priorCompaction: {
        summary: 'Prior work on auth',
        createdAt: '2026-01-01T00:00:00.000Z',
        tokenEstimate: 10
      },
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    expect(result.system).toContain('Prior work on auth')
    expect(result.system).toContain('<prior_session>')
    // Age stamp: fold declares when it was taken and defers to live history.
    expect(result.system).toContain('messages at 2026-01-01T00:00:00.000Z')
    expect(result.system).toContain('Everything since then is in the live history below')
    expect(result.systemStable).toContain('<prior_session>')
    expect(result.systemStable).toContain('Prior work on auth')
    expect(result.systemVolatile).not.toContain('<prior_session>')
    expect(result.systemVolatile).not.toContain('Prior work on auth')
    expect(result.systemVolatile).toContain('Date (UTC): 2026-08-16T12:00:00.000Z')
    const live = volatileSessionMessage(result.systemVolatile)
    expect(live.content).toContain('<live_session>')
    expect(live.content).toContain('Date (UTC): 2026-08-16T12:00:00.000Z')
    expect(live.content).not.toContain('<prior_session>')
    expect(live.content).not.toContain('Prior work on auth')
  })

  it('injects current task list into volatile system', async () => {
    const result = await assembleContext({
      harness: 'harness',
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: null,
      goal: 'hello',
      model,
      toolsJsonEstimate: 100,
      taskList: '<task_list>\n1/2 complete\n[x] (1) Done\n[~] (2) Next',
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    expect(result.systemVolatile).toContain('<task_list>')
    expect(result.systemVolatile).toContain('[~] (2) Next')
    expect(result.systemStable).not.toContain('Current task list')
  })

  it('injects loop hint as run notice when provided', async () => {
    const result = await assembleContext({
      harness: 'harness',
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: null,
      goal: 'hi',
      model,
      toolsJsonEstimate: 50,
      loopHint: 'Last 3 agent steps had only tool failures.',
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    expect(result.system).toContain('<run_notice>')
    expect(result.system).toContain('tool failures')
  })

  it('keeps Ask mode section after compaction rebuild', async () => {
    const longHistory = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `turn ${i} ${'x'.repeat(2_000)}`
    }))
    const result = await assembleContext({
      harness: 'harness',
      messages: longHistory,
      workspacePath: null,
      goal: 'hi',
      model: { ...model, contextWindow: 8_000 },
      toolsJsonEstimate: 50,
      modeSection: '<mode>\nAsk mode.\nYou are in Ask mode.\n</mode>',
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    expect(result.system).toContain('<mode>')
    expect(result.system).toContain('You are in Ask mode.')
  })

  it('strips legacy # Run contract H1 before wrapping', async () => {
    const result = await assembleContext({
      harness: '## Context\nAgent',
      contract: '# Run contract\n\n## Goal\nShip it\n\n## Done when\n\n- done\n',
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: null,
      goal: 'hello',
      model,
      toolsJsonEstimate: 100,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    expect(result.system).toContain('<run_contract>')
    expect(result.system).toContain('## Goal')
    expect(result.system).toContain('Ship it')
    expect(result.system.match(/^# Run contract\b/m)).toBeNull()
    expect(result.system.match(/^## Run contract\b/m)).toBeNull()
  })

  it('keeps run_contract paired when the body is budget-capped', async () => {
    const contract = `## Goal\n${'Ship it. '.repeat(8_000)}`
    const result = await assembleContext({
      harness: 'harness',
      contract,
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: null,
      goal: 'hello',
      model: { ...model, contextWindow: 8_000 },
      toolsJsonEstimate: 100,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    const start = result.system.indexOf('<run_contract>')
    const end = result.system.lastIndexOf('</run_contract>')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const section = result.system.slice(start, end + '</run_contract>'.length)
    expect(section.startsWith('<run_contract>')).toBe(true)
    expect(section.endsWith('</run_contract>')).toBe(true)
    expect(section.length).toBeLessThan(contract.length)
    expect(section).toContain('## Goal')
  })

  it('injects plan into system prompt when provided', async () => {
    const result = await assembleContext({
      harness: 'harness',
      contract: '## Goal\nShip',
      plan: '# Plan\n\n1. Do the thing',
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: null,
      goal: 'hello',
      model,
      toolsJsonEstimate: 100,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    expect(result.system).toContain('<plan>')
    expect(result.system).toContain('Do the thing')
  })

  it('Plan-mode verbatim plan keeps the # Plan heading and is not truncated', async () => {
    const steps = Array.from({ length: 80 }, (_, i) => `${i + 1}. Edit src/file${i}.ts`).join('\n')
    const plan = ['# Plan', '', '## Goal', '', 'Ship the planner.', '', '## Ordered steps', '', steps].join(
      '\n'
    )
    const result = await assembleContext({
      harness: 'harness',
      contract: '## Goal\nShip',
      plan,
      planVerbatim: true,
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: null,
      goal: 'hello',
      model,
      toolsJsonEstimate: 100,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    const inner = result.systemStable.match(/<plan>\n([\s\S]*?)\n<\/plan>/)?.[1]
    expect(inner).toBe(plan)
    expect(inner).toContain('# Plan')
    expect(inner).toContain('Edit src/file79.ts')
    expect(inner).not.toContain('…')
  })

  it('injects session env when provided', async () => {
    const result = await assembleContext({
      harness: 'harness',
      sessionEnv: '<session>\nOS: Windows',
      messages: [{ role: 'user', content: 'hi' }],
      workspacePath: null,
      goal: 'hi',
      model,
      toolsJsonEstimate: 50,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    expect(result.system).toContain('<session>')
    expect(result.system).toContain('OS: Windows')
  })

  it('places stable instruction layers before volatile data', async () => {
    const workspace = join(tmpdir(), `vyotiq-assemble-order-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'AGENTS.md'), 'WORKSPACE_RULE_MARKER: keep tests green.\n', 'utf8')
    try {
      const result = await assembleContext({
        harness: '## Role\nAgent',
        contract: '## Goal\nShip',
        plan: '# Plan\n\n1. PLAN_STEP_MARKER',
        modeSection: '<mode>\nAgent mode. Full tools.\n</mode>',
        skillsSection: '<available_skills>\n- **x**: y\n</available_skills>',
        pluginRulesSection: '<plugin_rules>\n- **plugin-rule:a/b**: c\n</plugin_rules>',
        userRules: [
          {
            id: 'house',
            name: 'House style',
            body: 'USER_RULE_MARKER: prefer named exports.',
            enabled: true
          }
        ],
        sessionEnv: '<session>\nDate (UTC): 2026-08-01T12:00:00.000Z',
        taskList: '<task_list>\n1/1 complete\n[x] (1) Done',
        loopHint: 'tool failures',
        priorCompaction: {
          summary: 'Earlier work',
          createdAt: '2026-01-01T00:00:00.000Z',
          tokenEstimate: 10
        },
        messages: [{ role: 'user', content: 'hi' }],
        workspacePath: workspace,
        goal: 'hi',
        model,
        toolsJsonEstimate: 50,
        providerId: 'ollama',
        provider: mockProvider,
        signal: new AbortController().signal
      })
      const role = result.system.indexOf('## Role')
      const mode = result.system.indexOf('<mode>')
      const contract = result.system.indexOf('<run_contract>')
      const plan = result.system.indexOf('<plan>')
      const skills = result.system.indexOf('<available_skills>')
      const plugins = result.system.indexOf('<plugin_rules>')
      const userRules = result.system.indexOf('<user_rules>')
      const workspaceRules = result.system.indexOf('<workspace_rules>')
      const prior = result.system.indexOf('<prior_session>')
      const session = result.system.indexOf('<session>')
      const snapshot = result.system.indexOf('<workspace>')
      const tasks = result.system.indexOf('<task_list>')
      const notice = result.system.indexOf('<run_notice>')
      expect(role).toBeGreaterThanOrEqual(0)
      expect(mode).toBeGreaterThan(role)
      expect(contract).toBeGreaterThan(mode)
      expect(plan).toBeGreaterThan(contract)
      expect(skills).toBeGreaterThan(plan)
      expect(plugins).toBeGreaterThan(skills)
      expect(userRules).toBeGreaterThan(plugins)
      expect(workspaceRules).toBeGreaterThan(userRules)
      expect(prior).toBeGreaterThan(workspaceRules)
      expect(session).toBeGreaterThan(prior)
      expect(snapshot).toBeGreaterThan(session)
      expect(tasks).toBeGreaterThan(snapshot)
      expect(notice).toBeGreaterThan(tasks)
      expect(result.system).toContain('PLAN_STEP_MARKER')
      expect(result.system).toContain('USER_RULE_MARKER')
      expect(result.system).toContain('WORKSPACE_RULE_MARKER')
      expect(result.systemStable).toContain('<prior_session>')
      expect(result.systemStable).toContain('Earlier work')
      expect(result.systemStable).toContain('<workspace_rules>')
      expect(result.systemVolatile).not.toContain('<prior_session>')
      expect(result.systemVolatile).toContain('<session>')
      expect(result.systemVolatile).toContain('<run_notice>')
      expect(result.systemVolatile).toContain('<task_list>')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      clearRulesCache(workspace)
      clearWorkspaceSnapshotCache(workspace)
    }
  })

  it('keeps tool result bodies when far under budget (re-read loop regression)', async () => {
    const messages: import('@shared/ipc').ChatMessage[] = [
      { role: 'user', content: 'audit this codebase' },
      ...Array.from({ length: 8 }, (_, i) => [
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ id: `r${i}`, name: 'read', arguments: '{}' }]
        },
        {
          role: 'tool' as const,
          toolCallId: `r${i}`,
          toolName: 'read',
          content: `FILE_BODY_${i}\n` + 'x'.repeat(400)
        }
      ]).flat()
    ]
    const result = await assembleContext({
      harness: 'harness',
      messages,
      workspacePath: null,
      goal: 'audit this codebase',
      model,
      toolsJsonEstimate: 50,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    const bodies = result.messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(bodies).toHaveLength(8)
    expect(bodies.every((b) => b.includes('FILE_BODY_'))).toBe(true)
    expect(bodies.some((b) => b.includes('[cleared]'))).toBe(false)
  })

  it('does not auto-compact at soft trigger on huge windows', async () => {
    // History that fits the 40% history budget on a 1M window but exceeds a
    // legacy 64k soft trigger — no automatic LLM or soft-trigger trim.
    const longHistory: import('@shared/ipc').ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `turn ${i} ${'x'.repeat(12_000)}`
    }))
    for (let i = 0; i < 12; i++) {
      longHistory.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `tc${i}`, name: 'read', arguments: '{}' }]
      })
      longHistory.push({
        role: 'tool',
        toolCallId: `tc${i}`,
        toolName: 'read',
        content: 'BODY'.repeat(4_000)
      })
    }
    const result = await assembleContext({
      harness: 'harness',
      messages: longHistory,
      workspacePath: null,
      goal: 'hi',
      model: { ...model, contextWindow: 1_000_000 },
      toolsJsonEstimate: 13_000,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal,
      keepRecentTurns: 20
    })
    expect(result.estimatedTokens).toBeGreaterThan(64_000)
    expect(result.compaction).toBeNull()
  })

  it('reuses stable prefix cache when only volatile session env changes', async () => {
    const { clearSystemPromptCache } = await import('@main/agent/context/assemble')
    clearSystemPromptCache()
    const base = {
      harness: '## Role\nStable agent',
      contract: '## Goal\nShip',
      messages: [{ role: 'user' as const, content: 'hi' }],
      workspacePath: null as string | null,
      goal: 'hi',
      model,
      toolsJsonEstimate: 50,
      providerId: 'ollama' as const,
      provider: mockProvider,
      signal: new AbortController().signal,
      priorCompaction: {
        summary: 'Folded auth work',
        createdAt: '2026-01-01T00:00:00.000Z',
        tokenEstimate: 10
      }
    }
    const first = await assembleContext({
      ...base,
      sessionEnv: '<session>\nDate (UTC): 2026-08-01T12:00:00.000Z'
    })
    const second = await assembleContext({
      ...base,
      sessionEnv: '<session>\nDate (UTC): 2026-08-01T12:00:01.000Z'
    })
    const stableMarker = '## Role\nStable agent'
    expect(first.system).toContain(stableMarker)
    expect(second.system).toContain(stableMarker)
    expect(first.system).toContain('12:00:00.000Z')
    expect(second.system).toContain('12:00:01.000Z')
    expect(first.systemStable).toContain('Folded auth work')
    expect(second.systemStable).toContain('Folded auth work')
    expect(first.systemVolatile).not.toContain('Folded auth work')
    // Stable contract + fold summary are identical across clock ticks.
    const firstStable = first.system.slice(0, first.system.indexOf('<session>'))
    const secondStable = second.system.slice(0, second.system.indexOf('<session>'))
    expect(firstStable).toBe(secondStable)
    expect(first.systemStable).toBe(second.systemStable)

    const folded = await assembleContext({
      ...base,
      priorCompaction: {
        summary: 'Folded billing work',
        createdAt: '2026-01-02T00:00:00.000Z',
        tokenEstimate: 12
      },
      sessionEnv: '<session>\nDate (UTC): 2026-08-01T12:00:02.000Z'
    })
    expect(folded.systemStable).toContain('Folded billing work')
    expect(folded.systemStable).not.toContain('Folded auth work')
    expect(folded.systemStable).not.toBe(second.systemStable)
  })

  it('keeps the compaction age line byte-stable across clock advances (provider prefix cache)', async () => {
    // The fold line sits in the STABLE system, so its bytes must not depend on
    // the wall clock — otherwise every app restart (or first rebuild after
    // enough time passes) rewrites the stable prefix and busts the provider
    // prompt cache for the system + entire history on that step.
    const { clearSystemPromptCache } = await import('@main/agent/context/assemble')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'))
      const base = {
        harness: '## Role\nStable agent',
        contract: '## Goal\nShip',
        messages: [{ role: 'user' as const, content: 'hi' }],
        workspacePath: null as string | null,
        goal: 'hi',
        model,
        toolsJsonEstimate: 50,
        providerId: 'ollama' as const,
        provider: mockProvider,
        signal: new AbortController().signal,
        priorCompaction: {
          summary: 'Folded refactor work',
          createdAt: '2026-08-01T09:30:00.000Z',
          tokenEstimate: 10
        }
      }
      const first = await assembleContext({ ...base })
      // Simulated restart: same fold, wall clock advanced 2.5h (past the age
      // rounding boundary), fingerprint cache cleared.
      vi.setSystemTime(new Date('2026-08-01T14:30:00.000Z'))
      clearSystemPromptCache()
      const second = await assembleContext({ ...base })
      expect(second.systemStable).toBe(first.systemStable)
      expect(second.systemStable).not.toMatch(/\d+[hm] ago/)
      expect(second.systemStable).toContain('messages at 2026-08-01T09:30:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not force trim when provider input is above estimate but under window', async () => {
    const history: import('@shared/ipc').ChatMessage[] = [{ role: 'user', content: 'start' }]
    for (let i = 0; i < 8; i++) {
      history.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `tc${i}`, name: 'read', arguments: '{}' }]
      })
      history.push({
        role: 'tool',
        toolCallId: `tc${i}`,
        toolName: 'read',
        content: `BODY${i}-`.repeat(200)
      })
    }
    const smallModel = { ...model, contextWindow: 20_000 }
    const withProvider = await assembleContext({
      harness: 'harness',
      messages: history,
      workspacePath: null,
      goal: 'hi',
      model: smallModel,
      toolsJsonEstimate: 100,
      lastUsage: { inputTokens: 11_000 },
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal,
      keepRecentTurns: 20
    })
    const cleared = withProvider.messages.filter(
      (m) => m.role === 'tool' && String(m.content).includes('[cleared]')
    )
    expect(cleared.length).toBe(0)
  })

  it('stubs earlier Skill tool results in the assembled history', async () => {
    const reviewBody = [
      '# Skill: review-code',
      '',
      'Review the diff before editing. Lead with severity, then a concrete patch.'
    ].join('\n')
    const testsBody = [
      '# Skill: write-tests',
      '',
      'Add vitest coverage for the changed login handler in src/main/ipc/register.ts.'
    ].join('\n')
    const result = await assembleContext({
      harness: 'harness',
      messages: [
        { role: 'user', content: 'Review auth then add tests' },
        {
          role: 'tool',
          toolName: 'Skill',
          toolCallId: 's1',
          content: reviewBody
        },
        {
          role: 'tool',
          toolName: 'Skill',
          toolCallId: 's2',
          content: testsBody
        }
      ],
      workspacePath: null,
      goal: 'Review auth then add tests',
      model,
      toolsJsonEstimate: 50,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })
    const skillResults = result.messages.filter((m) => m.role === 'tool' && m.toolName === 'Skill')
    expect(skillResults).toHaveLength(2)
    expect(String(skillResults[0]?.content)).toBe(SKILL_BODY_STUB)
    expect(String(skillResults[0]?.content)).not.toContain('Lead with severity')
    expect(String(skillResults[1]?.content)).toContain(
      'Add vitest coverage for the changed login handler'
    )
  })
})

describe('shouldTriggerAutoCompact', () => {
  it('anchors on provider input tokens when available — estimate alone cannot trigger', () => {
    // Reproduces run b0d72041: estimate 500k >> trigger 300k, provider says 148k.
    expect(shouldTriggerAutoCompact(500_000, 300_000, 148_000)).toEqual({
      trigger: false,
      source: 'provider'
    })
    expect(shouldTriggerAutoCompact(500_000, 300_000, 310_000)).toEqual({
      trigger: true,
      source: 'provider'
    })
  })

  it('falls back to the estimate when no provider figure exists yet', () => {
    expect(shouldTriggerAutoCompact(310_000, 300_000, null)).toEqual({
      trigger: true,
      source: 'estimate'
    })
    expect(shouldTriggerAutoCompact(310_000, 300_000, undefined)).toEqual({
      trigger: true,
      source: 'estimate'
    })
    expect(shouldTriggerAutoCompact(290_000, 300_000, 0)).toEqual({
      trigger: false,
      source: 'estimate'
    })
  })
})
