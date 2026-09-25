import { describe, expect, it } from 'vitest'
import { promptPrefixFingerprint } from '@main/agent/context/promptPrefix'

const tools = [
  { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
  { name: 'grep', description: 'Search files', parameters: { type: 'object' } }
]

describe('promptPrefixFingerprint', () => {
  it('is stable for an identical prefix', () => {
    const a = promptPrefixFingerprint(tools, '<harness>rules</harness>')
    const b = promptPrefixFingerprint(structuredClone(tools), '<harness>rules</harness>')
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(b).toBe(a)
  })

  it('changes when the stable system zone changes, even at the same length', () => {
    // The class of bug token sizes cannot see: one nonce byte used to make every
    // step's prefix unique.
    expect(promptPrefixFingerprint(tools, 'nonce=aaaa')).not.toBe(
      promptPrefixFingerprint(tools, 'nonce=bbbb')
    )
  })

  it('changes when the tool catalog changes, including its order', () => {
    const base = promptPrefixFingerprint(tools, 'system')
    expect(promptPrefixFingerprint(tools.slice(0, 1), 'system')).not.toBe(base)
    expect(promptPrefixFingerprint([...tools].reverse(), 'system')).not.toBe(base)
  })

  it('does not let tools and system text alias across the boundary', () => {
    expect(promptPrefixFingerprint([], 'x')).not.toBe(promptPrefixFingerprint(['x'], ''))
  })
})
