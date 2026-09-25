import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatResponseStyle } from '@main/agent/context/userRules'

// Settings length limits (src/shared/ipc/schemas/settings.ts):
// agentPersona max 1000, agentTone max 2000, agentIdentity max 1000.
const PERSONA_MAX_LENGTH = 1000
const IDENTITY_MAX_LENGTH = 1000

describe('no built-in persona, identity or tone', () => {
  it('has no shared module exporting defaults', () => {
    // The app ships no persona of its own: persona/identity/tone are the
    // user's to set, and an unconfigured assistant gets none. Re-adding a
    // default constant module puts an imposed character back in every prompt.
    expect(existsSync(resolve(__dirname, '../../../src/shared/agentPersona.ts'))).toBe(false)
  })

  it('emits nothing when the user has configured nothing', () => {
    expect(formatResponseStyle({})).toBe('')
    expect(formatResponseStyle({ persona: '', identity: '', tone: '' })).toBe('')
    expect(formatResponseStyle({ persona: '   ', identity: '  ', tone: '\n' })).toBe('')
  })

  it('never names the assistant on its own', () => {
    expect(formatResponseStyle({ tone: 'playful' })).not.toContain('Agent V')
  })
})

describe('user-set persona / identity / tone', () => {
  it('renders a response_style section from the user values', () => {
    const section = formatResponseStyle({ persona: 'Nova', tone: 'Blunt and concise.' })
    expect(section).toContain('response_style')
    expect(section).toContain('Identity: this assistant is "Nova"')
    expect(section).toContain('Tone: apply this tone in replies: "Blunt and concise.".')
  })

  it('renders the identity blurb before the persona name line', () => {
    const section = formatResponseStyle({
      identity: 'Reads the code before acting.',
      persona: 'Nova',
      tone: 'Blunt.'
    })
    expect(section).toContain('<response_style>')
    const blurbIdx = section.indexOf('Identity: Reads the code before acting.')
    const personaIdx = section.indexOf('Identity: this assistant is "Nova"')
    expect(blurbIdx).toBeGreaterThanOrEqual(0)
    expect(personaIdx).toBeGreaterThan(blurbIdx)
    expect(section).toContain('</response_style>')
  })

  it('accepts values up to the settings length limits', () => {
    const persona = 'N'.repeat(PERSONA_MAX_LENGTH)
    const identity = 'I'.repeat(IDENTITY_MAX_LENGTH)
    const section = formatResponseStyle({ persona, identity })
    expect(section).toContain(`Identity: ${identity}`)
    expect(section).toContain(`Identity: this assistant is "${persona}"`)
  })
})

