import { describe, expect, it } from 'vitest'
import {
  BUILTIN_COMMANDS,
  YIELDING_BUILTINS,
  parseReviewScope,
  resolveBuiltin
} from '../../../src/main/agent/slashCommands/builtins'

describe('/init and /review', () => {
  it('lists both as built-ins that yield to a person’s own command', () => {
    const triggers = BUILTIN_COMMANDS.map((c) => c.trigger)
    expect(triggers).toEqual(expect.arrayContaining(['init', 'review']))
    expect([...YIELDING_BUILTINS]).toEqual(['init', 'review'])
  })

  it('/init sends an AGENTS.md brief in Agent mode, with the text after it', () => {
    const result = resolveBuiltin('builtin:init', 'mention the e2e recipe')
    expect(result).toMatchObject({ action: 'send', mode: 'agent' })
    const message = result?.action === 'send' ? result.message : ''
    expect(message).toMatch(/AGENTS\.md at the workspace root/)
    expect(message).toMatch(/improve it in place/)
    expect(message).toMatch(/Also: mention the e2e recipe$/)
  })

  it('/review defaults to uncommitted changes and never edits', () => {
    const result = resolveBuiltin('builtin:review', '')
    expect(result?.action).toBe('send')
    const message = result?.action === 'send' ? result.message : ''
    expect(message).toMatch(/^Review the uncommitted changes/)
    expect(message).toMatch(/do not edit, commit or revert/)
    expect(message).not.toMatch(/Focus:/)
    // Review keeps the mode the person is in.
    expect(result).not.toHaveProperty('mode')
  })

  it('/review reads a scope word and keeps the rest as focus', () => {
    expect(parseReviewScope('branch the auth changes')).toEqual({ scope: 'branch', focus: 'the auth changes' })
    expect(parseReviewScope('task')).toEqual({ scope: 'task', focus: '' })
    expect(parseReviewScope('security only')).toEqual({ scope: 'uncommitted', focus: 'security only' })
    const branch = resolveBuiltin('builtin:review', 'branch')
    expect(branch?.action === 'send' ? branch.message : '').toMatch(/git merge-base/)
  })
})
