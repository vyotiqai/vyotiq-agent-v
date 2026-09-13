import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { buildSessionEnvSection } from '@main/agent/context/sessionEnv'

describe('buildSessionEnvSection', () => {
  it('includes UTC, local time with timezone, OS version, and shell — not mode', () => {
    const section = buildSessionEnvSection('powershell')
    expect(section).toMatch(/^<session>\n/)
    expect(section).toContain('</session>')
    expect(section).toContain('Date (UTC):')
    expect(section).toMatch(/Date \(UTC\): \d{4}-\d{2}-\d{2}T/)
    expect(section).toContain('Date (local):')
    expect(section).toMatch(
      /Date \(local\): \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(.+, UTC[+-]\d{2}:\d{2}\)/
    )
    expect(section).toContain(`OS:`)
    expect(section).toContain(os.release())
    expect(section).toContain('Shell (terminal): powershell')
    expect(section).not.toContain('Interaction mode:')
    expect(section).not.toContain('Automatic mode switching:')
    expect(section).toMatch(/OS: /)
  })

  it('resolves auto shell without restating mode', () => {
    const section = buildSessionEnvSection('auto')
    expect(section).toMatch(/^<session>\n/)
    expect(section).toContain('Shell (terminal):')
    expect(section).not.toContain('Interaction mode:')
  })
})
