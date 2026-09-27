/**
 * concept_search scores every stored vector on the main process. The scan must
 * give the event loop turns and honour an abort part-way through.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodeIndexStore } from '@main/agent/codeindex/store'
import { conceptSearchStore } from '@main/agent/codeindex/query'

const ROWS = 12_000
let store: CodeIndexStore

beforeAll(() => {
  store = CodeIndexStore.openMemory()
  const perFile = 50
  for (let f = 0; f < ROWS / perFile; f++) {
    store.replaceFileChunks(
      `src/f${f}.ts`,
      `h${f}`,
      1,
      1,
      Array.from({ length: perFile }, (_, i) => ({
        startLine: i + 1,
        endLine: i + 1,
        kind: 'function' as const,
        name: `fn_${f}_${i}`,
        ftsBody: `fn_${f}_${i}`,
        text: `function fn_${f}_${i}() {}`
      }))
    )
  }
  store.setDenseModel('Xenova/all-MiniLM-L6-v2', 384)
  const ids = (store.db.prepare('SELECT id FROM dense_chunks').all() as { id: number }[]).map(
    (r) => r.id
  )
  store.db.exec('BEGIN')
  for (const id of ids) {
    const v = new Float32Array(384)
    v[0] = id / ROWS
    store.setDenseVector(id, v)
  }
  store.db.exec('COMMIT')
})

afterAll(() => store.close())

const query = new Float32Array(384)
query[0] = 1

describe('concept search scan', () => {
  it('ranks the same top hits page by page', async () => {
    const hits = await conceptSearchStore(store, 'x', { limit: 3, embed: async () => [query] })
    expect(hits.map((h) => h.name)).toEqual(['fn_239_49', 'fn_239_48', 'fn_239_47'])
  })

  it('lets the event loop run while it scans', async () => {
    let ticks = 0
    const ticker = setInterval(() => {
      ticks++
    }, 0)
    try {
      const search = conceptSearchStore(store, 'x', { embed: async () => [query] })
      ticks = 0
      await search
    } finally {
      clearInterval(ticker)
    }
    expect(ticks).toBeGreaterThan(0)
  })

  it('stops mid-scan when aborted', async () => {
    const controller = new AbortController()
    const search = conceptSearchStore(store, 'x', {
      signal: controller.signal,
      embed: async () => {
        // Abort as soon as the scan has started.
        setImmediate(() => controller.abort())
        return [query]
      }
    })
    await expect(search).rejects.toThrow(/Aborted/)
  })
})
