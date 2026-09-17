import { describe, expect, it } from 'vitest'
import { CodeIndexStore } from '@main/agent/codeindex/store'
import {
  denseEmbedInput,
  runDenseVectorization,
  type DenseEmbedder
} from '@main/agent/codeindex/denseJob'
import { conceptSearchStore } from '@main/agent/codeindex/query'
import { EMBED_DIM, EMBED_MODEL_ID } from '@main/agent/codeindex/embed/embedModels'

/** Deterministic stub embedder: token presence in a 4-dim space, padded to EMBED_DIM. */
const TOKEN_DIM: Record<string, number> = { alpha: 0, beta: 1, gamma: 2, delta: 3 }

function stubEmbedder(log?: { texts: string[]; calls: number[] }): DenseEmbedder {
  return async (texts) => {
    log?.calls.push(texts.length)
    log?.texts.push(...texts)
    return texts.map((text) => {
      const vec = new Float32Array(EMBED_DIM)
      let norm = 0
      for (const [token, dim] of Object.entries(TOKEN_DIM)) {
        if (text.includes(token)) {
          vec[dim] = 1
          norm += 1
        }
      }
      if (norm > 0) {
        for (let d = 0; d < 4; d++) vec[d] = vec[d]! / norm
      } else {
        vec[3] = 1
      }
      return vec
    })
  }
}

function chunkItem(startLine: number, name: string, text: string) {
  return {
    startLine,
    endLine: startLine + 1,
    kind: 'function' as const,
    name,
    parentName: undefined,
    ftsBody: `${name}\n${text}`,
    text
  }
}

function seed(
  store: CodeIndexStore,
  path: string,
  items: { startLine: number; name: string; text: string }[]
): void {
  store.replaceFileChunks(
    path,
    `hash-${path}-${items.length}`,
    1,
    100,
    items.map((i) => chunkItem(i.startLine, i.name, i.text))
  )
}

describe('runDenseVectorization', () => {
  it('embeds pending rows in batches and stores the model identity', async () => {
    const store = CodeIndexStore.openMemory()
    const log = { texts: [] as string[], calls: [] as number[] }
    seed(store, 'a.ts', [
      { startLine: 1, name: 'alphaFn', text: 'alpha handling' },
      { startLine: 10, name: 'betaFn', text: 'beta handling' },
      { startLine: 20, name: 'gammaFn', text: 'gamma handling' }
    ])
    const res = await runDenseVectorization(store, {
      embed: stubEmbedder(log),
      batchSize: 2
    })
    expect(res.embedded).toBe(3)
    // Batch calls: 2 + 1, texts in id order.
    expect(log.calls).toEqual([2, 1])
    expect(store.denseStatus()).toEqual({ total: 3, vectorized: 3 })
    expect(store.getDenseModel()).toEqual({ model: EMBED_MODEL_ID, dim: EMBED_DIM })
  })

  it('resumes: only vec-NULL rows are embedded on a second run', async () => {
    const store = CodeIndexStore.openMemory()
    const log = { texts: [] as string[], calls: [] as number[] }
    seed(store, 'a.ts', [{ startLine: 1, name: 'alphaFn', text: 'alpha' }])
    await runDenseVectorization(store, { embed: stubEmbedder() })
    seed(store, 'b.ts', [
      { startLine: 1, name: 'betaFn', text: 'beta' },
      { startLine: 5, name: 'deltaFn', text: 'delta' }
    ])
    const res = await runDenseVectorization(store, { embed: stubEmbedder(log) })
    expect(res.embedded).toBe(2)
    expect(log.texts).toHaveLength(2)
    expect(log.texts[0]).toContain('b.ts')
    expect(store.denseStatus()).toEqual({ total: 3, vectorized: 3 })
  })

  it('abort mid-run keeps completed batches and a rerun finishes the job', async () => {
    const store = CodeIndexStore.openMemory()
    seed(store, 'a.ts', [
      { startLine: 1, name: 'alphaFn', text: 'alpha' },
      { startLine: 10, name: 'betaFn', text: 'beta' },
      { startLine: 20, name: 'gammaFn', text: 'gamma' }
    ])
    const ac = new AbortController()
    let calls = 0
    const embed: DenseEmbedder = async (texts) => {
      calls++
      if (calls === 1) {
        const vecs = await stubEmbedder()(texts)
        ac.abort()
        return vecs
      }
      return stubEmbedder()(texts)
    }
    await expect(
      runDenseVectorization(store, { embed, signal: ac.signal, batchSize: 2 })
    ).rejects.toMatchObject({ name: 'AbortError' })
    // First batch persisted before the abort.
    expect(store.denseStatus().vectorized).toBe(2)
    const res = await runDenseVectorization(store, { embed: stubEmbedder() })
    expect(res.embedded).toBe(1)
    expect(store.denseStatus().vectorized).toBe(3)
  })

  it('a stored model identity mismatch forces a full reset and re-embed', async () => {
    const store = CodeIndexStore.openMemory()
    store.setDenseModel('old-model', EMBED_DIM)
    seed(store, 'a.ts', [
      { startLine: 1, name: 'alphaFn', text: 'alpha' },
      { startLine: 10, name: 'betaFn', text: 'beta' }
    ])
    // Manually vectorize under the old identity to prove the reset clears it.
    const rows = store.pendingDenseBatch(10)
    const vecs = await stubEmbedder()(rows.map((r) => r.text))
    for (let i = 0; i < rows.length; i++) store.setDenseVector(rows[i]!.id, vecs[i]!)
    expect(store.denseStatus().vectorized).toBe(2)
    const log = { texts: [] as string[], calls: [] as number[] }
    const res = await runDenseVectorization(store, { embed: stubEmbedder(log) })
    expect(res.embedded).toBe(2)
    expect(log.texts).toHaveLength(2)
    expect(store.getDenseModel()).toEqual({ model: EMBED_MODEL_ID, dim: EMBED_DIM })
    expect(store.denseStatus()).toEqual({ total: 2, vectorized: 2 })
  })

  it('denseEmbedInput: path + name header, parent line, then text', () => {
    expect(
      denseEmbedInput({ path: 'src/a.ts', name: 'alphaFn', parentName: 'Alpha', text: 'body' })
    ).toBe('src/a.ts :: alphaFn\nAlpha\nbody')
    expect(
      denseEmbedInput({ path: 'src/a.ts', name: 'alphaFn', parentName: null, text: 'body' })
    ).toBe('src/a.ts :: alphaFn\nbody')
  })
})

describe('conceptSearchStore', () => {
  it('ranks by cosine against the embedded chunk vectors', async () => {
    const store = CodeIndexStore.openMemory()
    seed(store, 'src/alpha.ts', [{ startLine: 1, name: 'alphaFn', text: 'alpha' }])
    seed(store, 'src/beta.ts', [{ startLine: 1, name: 'betaFn', text: 'beta' }])
    seed(store, 'src/mix.ts', [{ startLine: 1, name: 'mixFn', text: 'alpha beta' }])
    await runDenseVectorization(store, { embed: stubEmbedder() })

    const hits = await conceptSearchStore(store, 'alpha', { embed: stubEmbedder() })
    expect(hits).toHaveLength(3)
    expect(hits[0]!.path).toBe('src/alpha.ts')
    expect(hits[1]!.path).toBe('src/mix.ts')
    expect(hits[2]!.path).toBe('src/beta.ts')
    expect(hits[0]!.score).toBeCloseTo(1, 5)
    expect(hits[0]!.snippet).toContain('alpha')
  })

  it('respects the limit and returns [] for an empty query', async () => {
    const store = CodeIndexStore.openMemory()
    seed(store, 'a.ts', [{ startLine: 1, name: 'alphaFn', text: 'alpha' }])
    await runDenseVectorization(store, { embed: stubEmbedder() })
    const hits = await conceptSearchStore(store, 'alpha', { embed: stubEmbedder(), limit: 1 })
    expect(hits).toHaveLength(1)
    await expect(
      conceptSearchStore(store, '   ', { embed: stubEmbedder() })
    ).resolves.toEqual([])
  })

  it('skips incompatible-dimension rows instead of computing a meaningless dot', async () => {
    const store = CodeIndexStore.openMemory()
    seed(store, 'a.ts', [
      { startLine: 1, name: 'alphaFn', text: 'alpha' },
      { startLine: 10, name: 'betaFn', text: 'beta' }
    ])
    await runDenseVectorization(store, { embed: stubEmbedder() })
    // Corrupt one row's vector dimension directly in the DB.
    const bad = new Float32Array(2)
    bad[0] = 1
    store.db
      .prepare('UPDATE dense_chunks SET vec = ? WHERE id = ?')
      .run(Buffer.from(bad.buffer), 1)
    const hits = await conceptSearchStore(store, 'alpha', { embed: stubEmbedder() })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.path).toBe('a.ts')
  })
})