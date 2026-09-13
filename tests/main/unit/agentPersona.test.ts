import { describe, expect, it } from 'vitest'
import { formatResponseStyle } from '@main/agent/context/userRules'
import { DEFAULT_AGENT_IDENTITY, DEFAULT_AGENT_PERSONA, DEFAULT_AGENT_TONE } from '@shared/agentPersona'

// Settings length limits (src/shared/ipc/schemas/settings.ts):
// agentPersona max 1000, agentTone max 2000. The briefed renderer constants
// file (src/renderer/src/features/settings/constants.ts) does not exist in
// this workspace, so the IPC schema limits are authoritative.
const PERSONA_MAX_LENGTH = 1000
const TONE_MAX_LENGTH = 2000

describe('DEFAULT_AGENT_PERSONA / DEFAULT_AGENT_TONE', () => {
  it('exports non-empty constants after trim', () => {
    expect(DEFAULT_AGENT_PERSONA.trim().length).toBeGreaterThan(0)
    expect(DEFAULT_AGENT_TONE.trim().length).toBeGreaterThan(0)
  })

  it('exports the exact built-in persona', () => {
    expect(DEFAULT_AGENT_PERSONA).toBe('Agent V')
  })

  it('persona fits the settings length limit (max 1000)', () => {
    expect(DEFAULT_AGENT_PERSONA.length).toBeLessThanOrEqual(PERSONA_MAX_LENGTH)
  })

  it('tone fits the settings length limit (max 2000)', () => {
    expect(DEFAULT_AGENT_TONE.length).toBeLessThanOrEqual(TONE_MAX_LENGTH)
  })

  it('formatResponseStyle renders a response_style section with identity and tone', () => {
    const section = formatResponseStyle({
      persona: DEFAULT_AGENT_PERSONA,
      tone: DEFAULT_AGENT_TONE
    })
    expect(section).toContain('response_style')
    expect(section).toContain(`Identity: this assistant is "${DEFAULT_AGENT_PERSONA}"`)
    expect(section).toContain(`Tone: apply this tone in replies: "${DEFAULT_AGENT_TONE}".`)
  })

  it('formatResponseStyle stays empty at true-empty input', () => {
    expect(formatResponseStyle({})).toBe('')
  })
})

describe('DEFAULT_AGENT_IDENTITY', () => {
  it('exports a non-empty constant after trim', () => {
    expect(DEFAULT_AGENT_IDENTITY.trim().length).toBeGreaterThan(0)
  })

  it('identity fits the settings length limit (max 1000)', () => {
    expect(DEFAULT_AGENT_IDENTITY.length).toBeLessThanOrEqual(PERSONA_MAX_LENGTH)
  })

  it('formatResponseStyle renders the blurb line first inside response_style', () => {
    const section = formatResponseStyle({
      identity: DEFAULT_AGENT_IDENTITY,
      persona: DEFAULT_AGENT_PERSONA,
      tone: DEFAULT_AGENT_TONE
    })
    expect(section).toContain('<response_style>')
    const blurbIdx = section.indexOf(`Identity: ${DEFAULT_AGENT_IDENTITY}`)
    const personaIdx = section.indexOf(`Identity: this assistant is "${DEFAULT_AGENT_PERSONA}"`)
    expect(blurbIdx).toBeGreaterThanOrEqual(0)
    expect(personaIdx).toBeGreaterThan(blurbIdx)
    expect(section).toContain('</response_style>')
  })
})
