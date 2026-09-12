import { describe, expect, it } from 'vitest'
import { chunkSource } from '@main/agent/codeindex/chunk'
import type { CodeChunk } from '@main/agent/codeindex/types'

const BANNER_APPLY_STATE = `/**
 * Cosmetic filter engine.
 * How does the popup toggle the network blocking UI
 * for every site the user visits.
 */

/**
 * Build dynamic allow rules for whitelisted sites.
 */
export function applyState() {
  chrome.declarativeNetRequest.updateDynamicRules({ addRules: [] })
}

// later trailing comment about the whitelist UI
export function otherHelper() {
  return 1
}
`

function assertModuleContextSkipsApplyState(chunks: CodeChunk[]): void {
  const apply = chunks.find((c) => c.name === 'applyState')
  expect(apply).toBeTruthy()
  expect(apply!.text).toContain('updateDynamicRules')
  const modules = chunks.filter((c) => c.name === 'module_context')
  expect(modules.length).toBeGreaterThan(0)
  for (const m of modules) {
    expect(m.text).not.toContain('function applyState')
    expect(m.text).not.toContain('updateDynamicRules')
    expect(m.endLine < apply!.startLine || m.startLine > apply!.endLine).toBe(true)
  }
}

describe('codeindex chunkSource', () => {
  it('chunks TypeScript functions without cutting mid-body', () => {
    const src = `
import { x } from './x'

export function validateAuth(token: string): boolean {
  if (!token) return false
  return token.startsWith('Bearer ')
}

export class AuthService {
  verify(userId: string): boolean {
    return userId.length > 0
  }
}
`
    const chunks = chunkSource('src/auth.ts', src)
    const names = chunks.map((c) => c.name)
    expect(names).toContain('validateAuth')
    expect(names).not.toContain('AuthService')
    const method = chunks.find((c) => c.name === 'verify')
    expect(method).toBeTruthy()
    expect(method!.parentName).toBe('AuthService')
    const fn = chunks.find((c) => c.name === 'validateAuth')!
    expect(fn.text).toContain('token.startsWith')
    expect(fn.contextualizedText).toContain('file: src/auth.ts')
    expect(fn.startLine).toBeLessThan(fn.endLine)
    // No chunk should end mid-brace of validateAuth only halfway
    expect(fn.text.trim().endsWith('}')).toBe(true)
  })

  it('chunks Python defs by indent', () => {
    const src = `
def process_refund(order_id: str) -> None:
    amount = lookup(order_id)
    if amount > 0:
        charge(amount)

class Ledger:
    def apply(self, n: int) -> int:
        return n + 1
`
    const chunks = chunkSource('billing/refund.py', src)
    expect(chunks.some((c) => c.name === 'process_refund')).toBe(true)
    expect(chunks.some((c) => c.name === 'Ledger')).toBe(false)
    const apply = chunks.find((c) => c.name === 'apply')
    expect(apply).toBeTruthy()
    expect(apply!.parentName).toBe('Ledger')
    const refund = chunks.find((c) => c.name === 'process_refund')!
    expect(refund.text).toContain('charge(amount)')
  })

  it('does not chunk nested Python defs', () => {
    const src = `
def process_refund(order_id: str) -> None:
    def helper(n: int) -> int:
        return n + 1
    charge(helper(1))
`
    const chunks = chunkSource('billing/refund.py', src)
    expect(chunks.some((c) => c.name === 'process_refund')).toBe(true)
    expect(chunks.some((c) => c.name === 'helper')).toBe(false)
    const refund = chunks.find((c) => c.name === 'process_refund')!
    expect(refund.text).toContain('def helper')
  })

  it('chunks markdown by headings', () => {
    const src = `# Title\n\nIntro\n\n## Auth\n\nDetails about login.\n`
    const chunks = chunkSource('README.md', src)
    expect(chunks.some((c) => c.name === 'Auth')).toBe(true)
  })

  it('module_context covers banner+JSDoc orphans without spanning applyState', () => {
    assertModuleContextSkipsApplyState(chunkSource('background/service-worker.js', BANNER_APPLY_STATE))
  })
})
