/**
 * Background dense vectorization: embeds pending dense_chunks rows in batches
 * and stores Float32LE vectors. Resumable (only vec-NULL rows), abortable,
 * and model-gated (a stored model/dim mismatch forces a full reset so cosine
 * similarity is never computed across incompatible vector spaces).
 */
import { EMBED_DIM, EMBED_MODEL_ID } from './embed/embedModels'
import type { CodeIndexStore } from './store'

export type DenseEmbedder = (texts: string[]) => Promise<Float32Array[]>

export type DenseJobProgress = { done: number; total: number }

/**
 * Embedding input convention shared by the job and the query path: path and
 * chunk identity lead, then the raw source, so short chunks still carry file
 * context in the vector space.
 */
export function denseEmbedInput(row: {
  path: string
  name: string
  parentName: string | null
  text: string
}): string {
  return `${row.path} :: ${row.name}\n${row.parentName ? row.parentName + '\n' : ''}${row.text}`
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

/**
 * Embed every vec-NULL dense row until exhausted or aborted. Completed batches
 * are persisted as they land, so an abort or crash leaves resumable progress.
 */
export async function runDenseVectorization(
  store: CodeIndexStore,
  opts: {
    embed: DenseEmbedder
    signal?: AbortSignal
    batchSize?: number
    onProgress?: (p: DenseJobProgress) => void
  }
): Promise<{ embedded: number; total: number }> {
  const current = store.getDenseModel()
  if (!current || current.model !== EMBED_MODEL_ID || current.dim !== EMBED_DIM) {
    store.resetDenseVectors()
    store.setDenseModel(EMBED_MODEL_ID, EMBED_DIM)
  }
  const total = store.denseStatus().total
  let embedded = 0
  const batchSize = Math.max(1, opts.batchSize ?? 32)
  for (;;) {
    throwIfAborted(opts.signal)
    const batch = store.pendingDenseBatch(batchSize)
    if (batch.length === 0) break
    const vecs = await opts.embed(batch.map(denseEmbedInput))
    if (vecs.length !== batch.length) {
      throw new Error('Embedding returned a vector count mismatch')
    }
    // Persist the completed batch FIRST, then honor an abort — a preempted job
    // keeps every batch it already paid for, so reruns only embed what remains.
    for (let i = 0; i < batch.length; i++) {
      store.setDenseVector(batch[i]!.id, vecs[i]!)
      embedded++
    }
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const status = store.denseStatus()
    opts.onProgress?.({ done: status.vectorized, total: status.total })
  }
  return { embedded, total }
}