import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { searchCodeIndex } from '@main/agent/codeindex/query'
import { CodeIndexStore, codeindexDbPath } from '@main/agent/codeindex/store'
import { syncCodeIndex } from '@main/agent/codeindex/sync'
import { runDenseVectorization, type DenseEmbedder } from '@main/agent/codeindex/denseJob'
import { EMBED_DIM } from '@main/agent/codeindex/embed/embedModels'
import { toolConceptSearch } from '@main/agent/tools/conceptSearch'
import { hiddenSearchPaths } from '@main/agent/tools/codebaseSearch'
import { isIndexableSourcePath } from '@main/agent/tools/walk'
import { createPermissionPolicy } from '@main/agent/permissions'

/**
 * codebase_search and concept_search read many files at once, as grep does:
 * a file a permission rule denies (or asks before reading) stays out of what
 * they return — no path, no snippet — and the result says how many did.
 */

const dirs: string[] = []
function makeWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function policyFor(workspace: string) {
  return createPermissionPolicy({
    rules: [{ effect: 'deny', path: 'secrets/**', source: 'settings' }],
    workspaceRoot: workspace,
    userDataDir: null
  })
}

describe('codebase_search leaves protected files out', () => {
  it('skips a denied file’s chunks and docs hits, keeping the rest', async () => {
    const workspace = makeWorkspace('vyotiq-semantic-hide-')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    mkdirSync(join(workspace, 'secrets'), { recursive: true })
    mkdirSync(join(workspace, 'docs', 'secrets'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'pay.ts'), 'export function chargeHunterCard() { return 1 }\n')
    writeFileSync(join(workspace, 'secrets', 'keys.ts'), 'export const chargeHunterKey = "sk_live_hunter"\n')
    writeFileSync(join(workspace, 'docs', 'secrets', 'notes.md'), '# chargeHunter\n\nThe live key is sk_live_hunter.\n')
    const store = CodeIndexStore.openMemory()
    try {
      await syncCodeIndex(workspace, store)
      const policy = policyFor(workspace)
      const open = await searchCodeIndex(workspace, store, 'chargeHunter')
      expect(open.some((h) => h.path === 'secrets/keys.ts')).toBe(true)

      const hidden = hiddenSearchPaths((rel) => policy.hidesFromSearch('codebase_search', rel))
      const hits = await searchCodeIndex(workspace, store, 'chargeHunter', { hidePath: hidden.hidePath })
      expect(hits.map((h) => h.path)).toContain('src/pay.ts')
      expect(hits.some((h) => h.path.includes('secrets/'))).toBe(false)
      expect(hits.some((h) => h.snippet.includes('sk_live_hunter'))).toBe(false)
      expect(hidden.note()).toMatch(/^\n\n\d matching files? left out: a permission rule/)
    } finally {
      store.close()
    }
  })

  it('says nothing when nothing was left out', () => {
    expect(hiddenSearchPaths(() => false).note()).toBe('')
    expect(hiddenSearchPaths(undefined).hidePath).toBeUndefined()
  })

  it('never indexes the files the built-in secret asks cover', () => {
    for (const p of ['.env', 'app/.env.production', 'certs/server.pem', 'id_rsa', 'keys/id_rsa.pub']) {
      expect(isIndexableSourcePath(p)).toBe(false)
    }
    expect(isIndexableSourcePath('src/a.ts')).toBe(true)
  })
})

describe('concept_search leaves protected files out', () => {
  const embed: DenseEmbedder = async (texts) =>
    texts.map((text) => {
      const vec = new Float32Array(EMBED_DIM)
      vec[text.includes('ledger') ? 0 : 1] = 1
      return vec
    })

  it('drops a denied file from the dense top hits and says so', async () => {
    const workspace = makeWorkspace('vyotiq-concept-hide-')
    const store = CodeIndexStore.openDbPath(codeindexDbPath(workspace))
    try {
      for (const [path, name, text] of [
        ['secrets/ledger.ts', 'secretLedger', 'ledger master key'],
        ['src/ledger.ts', 'openLedger', 'ledger reader'],
        ['src/other.ts', 'other', 'unrelated']
      ] as const) {
        store.replaceFileChunks(path, `hash-${path}`, 1, 100, [
          { startLine: 1, endLine: 2, kind: 'function', name, ftsBody: `${name}\n${text}`, text }
        ])
      }
      await runDenseVectorization(store, { embed })
    } finally {
      store.close()
    }
    try {
      const policy = policyFor(workspace)
      const out = await toolConceptSearch(workspace, 'ledger', {
        embed,
        maxResults: 1,
        hidePath: (rel) => policy.hidesFromSearch('concept_search', rel)
      })
      expect(out).toContain('src/ledger.ts')
      expect(out).not.toContain('secrets/ledger.ts')
      expect(out).not.toContain('master key')
      expect(out).toMatch(/1 matching file left out: a permission rule/)
    } finally {
      CodeIndexStore.openDbPath(codeindexDbPath(workspace)).close()
    }
  })
})
