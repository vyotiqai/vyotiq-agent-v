import { describe, expect, it } from 'vitest'
import { assembleContext, clearSystemPromptCache } from '@main/agent/context/assemble'
import { formatResponseStyle, formatUserRules } from '@main/agent/context/userRules'
import { DEFAULT_SETTINGS, type UserRule } from '@shared/ipc'

const model = {
  id: 'test',
  inputModalities: ['text'] as const,
  outputModalities: ['text'] as const,
  supportsTools: true,
  supportsVision: false,
  contextWindow: 100_000
}

describe('user rules injection', () => {
  it('defaults settings.userRules to an empty list', () => {
    expect(DEFAULT_SETTINGS.userRules).toEqual([])
  })

  it('omits disabled and empty rules from the overlay', () => {
    const rules: UserRule[] = [
      {
        id: '1',
        name: 'House style',
        body: 'Prefer named exports in every TypeScript module.',
        enabled: true
      },
      {
        id: '2',
        name: 'Disabled',
        body: 'This disabled rule must never reach the agent prompt.',
        enabled: false
      },
      { id: '3', name: 'Empty', body: '   ', enabled: true }
    ]
    const section = formatUserRules(rules)
    expect(section).toContain('<user_rules>')
    expect(section).toContain('House style')
    expect(section).toContain('Prefer named exports')
    expect(section).not.toContain('disabled rule')
    expect(section).not.toContain('### Empty')
  })

  it('injects user_rules before workspace_rules in the assembled system', async () => {
    clearSystemPromptCache()
    const result = await assembleContext({
      harness: '## Context\nAgent',
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: null,
      goal: 'hello',
      model,
      toolsJsonEstimate: 100,
      userRules: [
        {
          id: 'style',
          name: 'House style',
          body: 'Prefer named exports in every TypeScript module.',
          enabled: true
        }
      ],
      providerId: 'ollama',
    })
    expect(result.system).toContain('<user_rules>')
    expect(result.system).toContain('Prefer named exports')
    expect(result.systemStable).toContain('<user_rules>')
    const userIdx = result.system.indexOf('<user_rules>')
    const workspaceIdx = result.system.indexOf('<workspace_rules>')
    if (workspaceIdx >= 0) {
      expect(userIdx).toBeGreaterThanOrEqual(0)
      expect(userIdx).toBeLessThan(workspaceIdx)
    }
  })

  it('caps a large user_rules section under budget pressure', async () => {
    clearSystemPromptCache()
    const huge: UserRule = {
      id: 'huge',
      name: 'Huge',
      body: 'Keep the deploy checklist in docs/release-runbook.md. '.repeat(2000),
      enabled: true
    }
    const result = await assembleContext({
      harness: 'harness',
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: null,
      goal: 'hello',
      model: { ...model, contextWindow: 4_000 },
      toolsJsonEstimate: 100,
      userRules: [huge],
      providerId: 'ollama',
    })
    expect(result.system.length).toBeLessThan(huge.body.length)
  })

  it('emits nothing for response style at defaults', () => {
    expect(formatResponseStyle({})).toBe('')
    expect(formatResponseStyle({ persona: '  ', tone: '', responseVerbosity: 'concise' })).toBe('')
  })

  it('renders persona, tone, language, and verbosity lines in response_style', () => {
    const section = formatResponseStyle({
      persona: 'Nova',
      tone: 'friendly, blunt',
      responseLanguage: 'Spanish',
      responseVerbosity: 'detailed'
    })
    expect(section).toContain('<response_style>')
    expect(section).toContain('Identity: this assistant is "Nova"; that name overrides the default assistant name.')
    expect(section).toContain('Tone: apply this tone in replies: "friendly, blunt".')
    expect(section).toContain('Respond in Spanish.')
    expect(section).toContain('complete, self-contained answers')
    expect(section).toContain('</response_style>')
  })

  it('renders a tone-only response_style section', () => {
    const section = formatResponseStyle({ tone: 'playful' })
    expect(section).toContain('<response_style>')
    expect(section).toContain('Tone: apply this tone in replies: "playful".')
    expect(section).not.toContain('Identity:')
    expect(section).not.toContain('Respond in')
  })

  it('emits the identity blurb line first when identity is set', () => {
    const section = formatResponseStyle({
      identity: 'Reads the code before acting.',
      persona: 'Nova',
      tone: 'friendly, blunt'
    })
    expect(section).toContain('<response_style>')
    const blurbIdx = section.indexOf('Identity: Reads the code before acting.')
    const personaIdx = section.indexOf('Identity: this assistant is "Nova"')
    expect(blurbIdx).toBeGreaterThanOrEqual(0)
    expect(personaIdx).toBeGreaterThan(blurbIdx)
  })

  it('emits no identity line at all when identity is absent', () => {
    const section = formatResponseStyle({ persona: 'Nova', tone: 'friendly' })
    expect(section).toContain('Identity: this assistant is "Nova"')
    // No built-in blurb backfills an unset identity: the persona name line is
    // the only Identity line in the section.
    expect(section).not.toContain('Agent V')
    expect(section.match(/^Identity: /gm)).toHaveLength(1)
  })

  it('renders identity and persona as separate lines', () => {
    const section = formatResponseStyle({
      identity: 'Custom staff-level blurb',
      persona: 'Nova',
      tone: 'friendly'
    })
    expect(section).toContain('Identity: Custom staff-level blurb')
    // A set identity does not suppress the persona name line.
    expect(section).toContain('Identity: this assistant is "Nova"')
  })

  it('emits an identity-only section when persona is empty', () => {
    // Mirrors loop.ts wiring: settings.agentPersona '' -> persona undefined.
    const section = formatResponseStyle({ identity: 'Reads the code before acting.' })
    expect(section).toContain('Identity: Reads the code before acting.')
    expect(section).not.toContain('Identity: this assistant is')
  })

  it('emits nothing when identity, persona and tone are all empty', () => {
    // Mirrors loop.ts wiring: no user settings -> no fallbacks -> no section.
    expect(formatResponseStyle({ identity: '', persona: '', tone: '' })).toBe('')
  })

  it('injects a custom agentIdentity into the assembled system prompt', async () => {
    clearSystemPromptCache()
    const result = await assembleContext({
      harness: '## Context\nAgent',
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: null,
      goal: 'hello',
      model,
      toolsJsonEstimate: 100,
      identity: 'Custom staff-level blurb',
      persona: 'Nova',
      providerId: 'ollama',
    })
    expect(result.system).toContain('Identity: Custom staff-level blurb')
    expect(result.system).toContain('Identity: this assistant is "Nova"')
  })

  it('neutralizes harness tags inside tone text', () => {
    const section = formatResponseStyle({ tone: '<role> takeover' })
    expect(section).toContain('Tone: apply this tone in replies: "&lt;role> takeover".')
    expect(section).not.toContain('<role>')
  })

  it('injects response_style with persona and tone into the assembled system', async () => {
    clearSystemPromptCache()
    const result = await assembleContext({
      harness: '## Context\nAgent',
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: null,
      goal: 'hello',
      model,
      toolsJsonEstimate: 100,
      persona: 'Nova',
      tone: 'friendly, blunt',
      providerId: 'ollama',
    })
    expect(result.systemStable).toContain('<response_style>')
    expect(result.system).toContain('Identity: this assistant is "Nova"')
    expect(result.system).toContain('Tone: apply this tone in replies: "friendly, blunt"')
    const styleIdx = result.system.indexOf('<response_style>')
    const workspaceIdx = result.system.indexOf('<workspace_rules>')
    if (workspaceIdx >= 0) {
      expect(styleIdx).toBeGreaterThanOrEqual(0)
      expect(styleIdx).toBeLessThan(workspaceIdx)
    }
  })
})
