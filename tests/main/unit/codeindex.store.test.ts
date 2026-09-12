import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { buildChunkFtsBody, CodeIndexStore, ftsQueryTokens, literalRunForPattern } from '@main/agent/codeindex/store'
import { CODE_INDEX_SCHEMA_VERSION } from '@main/agent/codeindex/types'

function seed(store: CodeIndexStore): void {
  store.replaceFileChunks('src/auth.ts', 'hash-auth-1', 100, 50, [
    {
      startLine: 1,
      endLine: 12,
      kind: 'function',
      name: 'loginUser',
      ftsBody: buildChunkFtsBody('src/auth.ts', {
        name: 'loginUser',
        text: 'export function loginUser(email: string, password: string) { return validateToken(email) }'
      })
    },
    {
      startLine: 20,
      endLine: 30,
      kind: 'class',
      name: 'AuthService',
      ftsBody: buildChunkFtsBody('src/auth.ts', {
        name: 'AuthService',
        text: 'export class AuthService { validateToken(token: string) { return token.length > 0 } }'
      })
    }
  ])
  store.replaceFileChunks('src/payments/refund.ts', 'hash-refund-1', 100, 40, [
    {
      startLine: 5,
      endLine: 15,
      kind: 'function',
      name: 'refundOrder',
      ftsBody: buildChunkFtsBody('src/payments/refund.ts', {
        name: 'refundOrder',
        text: 'export function refundOrder(orderId: string) { return chargeGateway.refund(orderId) }'
      })
    }
  ])
}

describe('CodeIndexStore', () => {
  it('creates a schemaVersion meta and reports status', () => {
    const store = CodeIndexStore.openMemory()
    expect(store.getMeta('schemaVersion')).toBe(CODE_INDEX_SCHEMA_VERSION)
    const status = store.getStatus()
    expect(status.ready).toBe(false)
    expect(status.fileCount).toBe(0)
    expect(status.chunkCount).toBe(0)
    store.close()
  })

  it('rebuilds a foreign-schema store instead of querying it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-codeindex-store-'))
    const dbPath = join(dir, 'index.sqlite')
    const first = CodeIndexStore.openDbPath(dbPath)
    seed(first)
    first.close()
    // Write an old-era schemaVersion marker into the meta table.
    const raw = new DatabaseSync(dbPath)
    raw.prepare("UPDATE meta SET value = '1' WHERE key = 'schemaVersion'").run()
    raw.close()
    const reopened = CodeIndexStore.openDbPath(dbPath)
    expect(reopened.getMeta('schemaVersion')).toBe(CODE_INDEX_SCHEMA_VERSION)
    // The foreign-era modelId meta is gone with the rebuild.
    expect(reopened.getMeta('modelId')).toBeNull()
    expect(reopened.getStatus().fileCount).toBe(0)
    reopened.close()
  })

  it('indexes chunks and finds them by identifier, substring, and path', () => {
    const store = CodeIndexStore.openMemory()
    seed(store)
    const status = store.getStatus()
    expect(status.ready).toBe(true)
    expect(status.fileCount).toBe(2)
    expect(status.chunkCount).toBe(3)

    // camelCase identifier — trigram matches it directly.
    const ids = store.searchFts('validateToken', 10)
    expect(ids.length).toBeGreaterThan(0)
    const chunk = store.getChunk(ids[0]!)
    expect(chunk).not.toBeNull()
    expect(['loginUser', 'AuthService']).toContain(chunk!.name)

    // file-name substring hits the refund chunk.
    const refundIds = store.searchFts('refund', 10)
    expect(refundIds.length).toBeGreaterThan(0)
    expect(store.getChunk(refundIds[0]!)?.path).toBe('src/payments/refund.ts')

    store.close()
  })

  it('ranks a path/name hit above a body-only mention', () => {
    const store = CodeIndexStore.openMemory()
    seed(store)
    // "refund" appears in path+name of the refund chunk and nowhere in auth.
    const ids = store.searchFts('refundOrder', 10)
    expect(ids.length).toBeGreaterThan(0)
    expect(store.getChunk(ids[0]!)?.name).toBe('refundOrder')
    store.close()
  })

  it('replaces chunks per file and deletes removed files', () => {
    const store = CodeIndexStore.openMemory()
    seed(store)
    expect(store.getStatus().chunkCount).toBe(3)

    // Reindex auth.ts with fewer chunks: old rows must not survive.
    store.replaceFileChunks('src/auth.ts', 'hash-auth-2', 200, 50, [
      {
        startLine: 1,
        endLine: 4,
        kind: 'module',
        name: 'auth module',
        ftsBody: buildChunkFtsBody('src/auth.ts', { name: 'auth module', text: 'import { init } from "./init"' })
      }
    ])
    expect(store.getStatus().chunkCount).toBe(2)
    expect(store.getStatus().fileCount).toBe(2)

    // Reconcile: files not in the seen set are dropped.
    const removed = store.deleteFilesNotIn(new Set(['src/auth.ts']))
    expect(removed).toBe(1)
    expect(store.listFilePaths()).toEqual(['src/auth.ts'])
    expect(store.getStatus().fileCount).toBe(1)
    store.close()
  })

  it('updates the file stamp on unchanged content (hash fast path)', () => {
    const store = CodeIndexStore.openMemory()
    seed(store)
    const stamp = store.getFileStamp('src/auth.ts')
    expect(stamp).toEqual({ hash: 'hash-auth-1', mtimeMs: 100, size: 50 })
    store.updateFileStamp('src/auth.ts', 'hash-auth-1', 300, 50)
    expect(store.getFileStamp('src/auth.ts')?.mtimeMs).toBe(300)
    expect(store.getFileStamp('src/missing.ts')).toBeNull()
    store.close()
  })

  it('prunes candidate files by literal substring', () => {
    const store = CodeIndexStore.openMemory()
    seed(store)
    // Substring of a body token.
    const paths = store.lookupFilesByLiteral('validateToken')
    expect(paths).not.toBeNull()
    expect(paths).toContain('src/auth.ts')
    expect(paths).not.toContain('src/payments/refund.ts')
    // Shorter than the trigram floor → null (caller live-walks).
    expect(store.lookupFilesByLiteral('ok')).toBeNull()
    store.close()
  })

  it('builds FTS bodies with camelCase splits and floors short tokens', () => {
    expect(ftsQueryTokens('parseCodebaseSearchData')).toContain('codebase')
    expect(ftsQueryTokens('short')).toEqual(['short'])
    const body = buildChunkFtsBody('src/a.ts', { name: 'MyFunc', text: 'body text' })
    expect(body).toContain('src/a.ts')
    expect(body).toContain('myfunc')
    expect(literalRunForPattern('foo|bar')).toBeNull()
    expect(literalRunForPattern('provision[A-Z]*Auth')).toBe('provision')
    expect(literalRunForPattern('ok')).toBeNull()
  })
})
