import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { searchCodeIndex, formatSearchHits, codebaseSearchHitPathsFromResult } from '@main/agent/codeindex/query'
import { CodeIndexStore } from '@main/agent/codeindex/store'
import { syncCodeIndex } from '@main/agent/codeindex/sync'

let workspace: string

afterEach(() => {
  if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
})

const AUTH_SRC = `import { sign } from './sign'

export function loginUser(email: string, password: string) {
  if (!password) throw new Error('password required')
  return sign(email)
}

export class AuthGuard {
  check(token: string): boolean {
    return token.length > 0
  }
}
`

const REFUND_SRC = `export function refundOrder(orderId: string, cents: number) {
  chargeGateway.refund(orderId, cents)
  auditLog.write('refund', orderId)
}
`

describe('codebase search over the FTS5 trigram index', () => {
  it('finds code by identifier, path fragment, and substring', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-codeindex-search-'))
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'auth.ts'), AUTH_SRC, 'utf8')
    writeFileSync(join(workspace, 'src', 'refund.ts'), REFUND_SRC, 'utf8')
    const store = CodeIndexStore.openMemory()
    await syncCodeIndex(workspace, store)

    // camelCase identifier.
    const byIdent = await searchCodeIndex(workspace, store, 'refundOrder')
    expect(byIdent.length).toBeGreaterThan(0)
    expect(byIdent[0]!.path).toBe('src/refund.ts')
    expect(byIdent[0]!.name).toBe('refundOrder')
    expect(byIdent[0]!.startLine).toBe(1)

    // File-path fragment reaches the refund chunk by path alone.
    const byPath = await searchCodeIndex(workspace, store, 'refund.ts')
    expect(byPath.length).toBeGreaterThan(0)
    expect(byPath.every((h) => h.path === 'src/refund.ts')).toBe(true)

    // Substring of a longer identifier (trigram).
    const bySub = await searchCodeIndex(workspace, store, 'loginUser')
    expect(bySub.length).toBeGreaterThan(0)
    expect(bySub[0]!.path).toBe('src/auth.ts')

    // camelCase query split still finds the token.
    const bySplit = await searchCodeIndex(workspace, store, 'guard check')
    expect(bySplit.length).toBeGreaterThan(0)
    expect(bySplit[0]!.path).toBe('src/auth.ts')

    // Snippet carries the real source lines.
    expect(bySub[0]!.snippet).toContain('loginUser')

    // No hits for text that exists nowhere.
    const none = await searchCodeIndex(workspace, store, 'totally_unrelated_zzz')
    expect(none).toEqual([])
    store.close()
  })

  it('includes docs/ markdown hits at search time even though they are not indexed', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-codeindex-docs-'))
    mkdirSync(join(workspace, 'src'), { recursive: true })
    mkdirSync(join(workspace, 'docs'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'app.ts'), 'export const app = 1\n', 'utf8')
    writeFileSync(
      join(workspace, 'docs', 'auth-guide.md'),
      '# Auth guide\n\nRefresh tokens rotate every hour.\n',
      'utf8'
    )
    const store = CodeIndexStore.openMemory()
    await syncCodeIndex(workspace, store)
    expect(store.listFilePaths()).toEqual(['src/app.ts'])

    const hits = await searchCodeIndex(workspace, store, 'refresh tokens')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.path).toBe('docs/auth-guide.md')
    store.close()
  })

  it('formats hits the way the renderer parser and citations expect', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-codeindex-format-'))
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'auth.ts'), AUTH_SRC, 'utf8')
    const store = CodeIndexStore.openMemory()
    await syncCodeIndex(workspace, store)
    const hits = await searchCodeIndex(workspace, store, 'loginUser')
    const formatted = formatSearchHits(hits)
    expect(formatted).toMatch(/^1\. src\/auth\.ts:\d+-\d+ \[function loginUser\] score=/)
    expect(formatted).toContain('loginUser')
    expect(codebaseSearchHitPathsFromResult(formatted)).toEqual(['src/auth.ts'])
    expect(formatSearchHits([])).toBe('No codebase_search hits.')
    expect(codebaseSearchHitPathsFromResult('no hits here')).toEqual([])
    store.close()
  })
})
