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

describe('teammate name in <response_style>', () => {
  const TEAMMATE_ROLE = 'A terse senior frontend engineer who never touches backend files.'

  it('tells a bound teammate its own name', () => {
    // The name was persisted to status.json for the UI and never reached the
    // model, so a teammate could not refer to itself, sign its work, or be
    // addressed by name in a handoff.
    const section = formatResponseStyle({ teammateName: 'Scout' })
    expect(section).toContain('Name: you are "Scout"')
    expect(section).toContain('overrides the default assistant name')
  })

  it('renders a teammate persona as a role, not as its name', () => {
    // loop.ts routes the profile's persona through `settings.agentPersona`,
    // which for an unbound chat is the name the user typed in Settings. A
    // teammate's persona is prose describing the job, so the unbound wording
    // told it its name was a sentence.
    const section = formatResponseStyle({
      teammateName: 'Scout',
      persona: TEAMMATE_ROLE
    })
    expect(section).toContain(`Role: ${TEAMMATE_ROLE}`)
    expect(section).not.toContain(`this assistant is "${TEAMMATE_ROLE}"`)
  })

  it('leaves an unbound chat exactly as it was', () => {
    const section = formatResponseStyle({ persona: 'Nova' })
    expect(section).toContain('Identity: this assistant is "Nova"')
    expect(section).not.toContain('Name: you are')
    expect(section).not.toContain('Role:')
  })

  it('leads with the name, which anchors every line under it', () => {
    const section = formatResponseStyle({
      teammateName: 'Scout',
      identity: 'Owns the design system.',
      persona: TEAMMATE_ROLE,
      tone: 'Direct.'
    })
    const name = section.indexOf('Name: you are "Scout"')
    const identity = section.indexOf('Identity: Owns the design system.')
    const role = section.indexOf(`Role: ${TEAMMATE_ROLE}`)
    expect(name).toBeGreaterThanOrEqual(0)
    expect(identity).toBeGreaterThan(name)
    expect(role).toBeGreaterThan(identity)
  })

  it('emits nothing for a blank name, so an unbound run gains no bytes', () => {
    // These lines sit in the cached stable prefix; an empty-string name must
    // not add a line that busts the prefix for every non-teammate chat.
    expect(formatResponseStyle({ teammateName: '   ' })).toBe('')
  })
})
