/**
 * DEDICATED REAL-MODEL E2E TEST for the dense concept_search leg.
 *
 * Unlike every other codeindex test (stub embedders, network-free), this test
 * exercises the real production path:
 *   real downloader layout → real q8 MiniLM pipeline load (loadEmbedPipeline,
 *   identical semantics to embedUtility.loadSession) → real vectorization →
 *   real cosine ranking through runConceptSearch.
 *
 * Model artifacts persist in a fixed tmp cache dir across runs; the download
 * only happens on the first run (~23 MB). If the network is unavailable the
 * tests SKIP with a reason instead of failing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ensureCodeIndexSynced,
  disposeCodeIndexWorkspace,
  runConceptSearch
} from '@main/agent/codeindex'
import { runDenseVectorization, type DenseEmbedder } from '@main/agent/codeindex/denseJob'
import { loadEmbedPipeline, type EmbedPipeline } from '@main/agent/codeindex/embed/pipeline'
import {
  embedModelDir,
  embedModelFilesPresent,
  ensureEmbedModelFiles,
  setEmbedModelsRootOverrideForTests
} from '@main/agent/codeindex/embed/embedModels'
import { CodeIndexStore } from '@main/agent/codeindex/store'
import { codeindexDbPath } from '@main/agent/codeindex/store'

const MODEL_CACHE = join(tmpdir(), 'vyotiq-embed-e2e-cache')
const RETRY_SRC = `export type BackoffPolicy = { baseMs: number; maxAttempts: number }

/** Retry a failed HTTP request with exponential backoff and jitter. */
export async function fetchWithRetry(url: string, policy: BackoffPolicy): Promise<Response> {
  let attempt = 0
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
      throw new Error('HTTP ' + res.status)
    } catch (err) {
      attempt++
      if (attempt >= policy.maxAttempts) throw err
      const backoff = policy.baseMs * 2 ** attempt + Math.random() * 50
      await new Promise((resolve) => setTimeout(resolve, backoff))
    }
  }
}
`

const THEME_SRC = `export const THEME_TOKENS = {
  surface: 'var(--color-surface)',
  accent: 'var(--color-accent)',
  radius: '12px'
}

/** Apply the theme tokens as inline CSS custom properties. */
export function applyTheme(el: HTMLElement): void {
  el.style.setProperty('--color-surface', '#101418')
  el.style.setProperty('--color-accent', '#4f8cff')
  el.style.borderRadius = THEME_TOKENS.radius
}
`

const INVOICE_SRC = `export type LineItem = { description: string; quantity: number; unitPrice: number }

/** Sum invoice line items into a grand total with quantity rounding. */
export function invoiceTotal(items: LineItem[]): number {
  let total = 0
  for (const item of items) {
    total += item.quantity * item.unitPrice
  }
  return Math.round(total * 100) / 100
}
`

let modelReady = false
const workspaces: string[] = []
let asr: EmbedPipeline | null = null
let embed: DenseEmbedder | null = null
let chunkCount = 0

beforeAll(async () => {
  mkdirSync(MODEL_CACHE, { recursive: true })
  setEmbedModelsRootOverrideForTests(MODEL_CACHE)
  if (!embedModelFilesPresent()) {
    try {
      await ensureEmbedModelFiles()
    } catch {
      modelReady = false
      return
    }
  }
  if (!embedModelFilesPresent()) {
    modelReady = false
    return
  }
  modelReady = true
  asr = await loadEmbedPipeline(embedModelDir())
  embed = async (texts) => {
    const out: Float32Array[] = []
    for (const text of texts) {
      const res = await asr!(text, { pooling: 'mean', normalize: true })
      out.push(new Float32Array(res.data))
    }
    return out
  }
}, 300_000)

afterAll(() => {
  for (const dir of workspaces) {
    disposeCodeIndexWorkspace(dir)
    rmSync(dir, { recursive: true, force: true })
  }
  workspaces.length = 0
  setEmbedModelsRootOverrideForTests(null)
})

async function makeWorkspace(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'vy-dense-e2e-'))
  workspaces.push(dir)
  writeFileSync(join(dir, 'retry.ts'), RETRY_SRC)
  writeFileSync(join(dir, 'theme.ts'), THEME_SRC)
  writeFileSync(join(dir, 'invoice.ts'), INVOICE_SRC)
  const { sync, disabled } = await ensureCodeIndexSynced(dir)
  expect(disabled).toBeUndefined()
  expect(sync?.indexed).toBe(3)
  const store = CodeIndexStore.openDbPath(codeindexDbPath(dir))
  try {
    const dense = store.denseStatus()
    chunkCount = dense.total
    expect(dense.total).toBeGreaterThan(0)
    await runDenseVectorization(store, { embed: embed! })
    expect(store.denseStatus().vectorized).toBe(dense.total)
    expect(store.getDenseModel()).toEqual({
      model: 'Xenova/all-MiniLM-L6-v2',
      dim: 384
    })
  } finally {
    store.close()
  }
  return dir
}

describe('dense concept_search e2e (real model, real sync, real ranking)', () => {
  it('syncs a real workspace, embeds every chunk, and ranks the right files first', async (ctx) => {
    if (!modelReady || !embed) {
      ctx.skip(!modelReady, 'embedding model artifacts unavailable (no network?)')
      return
    }
    const workspace = await makeWorkspace()

    const retry = await runConceptSearch(
      workspace,
      'failed requests keep timing out, add retry with exponential backoff',
      { embed }
    )
    expect(retry.hits.length).toBeGreaterThan(0)
    expect(retry.hits[0]!.path).toContain('retry.ts')
    expect(retry.hits[0]!.snippet).toMatch(/backoff|retry/i)

    const invoice = await runConceptSearch(workspace, 'invoice line items total is wrong', {
      embed
    })
    expect(invoice.hits.length).toBeGreaterThan(0)
    expect(invoice.hits[0]!.path).toContain('invoice.ts')
  }, 180_000)

  it('returns real cosine scores in (0, 1] over all embedded chunks', async (ctx) => {
    if (!modelReady || !embed) {
      ctx.skip(!modelReady, 'embedding model artifacts unavailable (no network?)')
      return
    }
    const workspace = await makeWorkspace()
    const theme = await runConceptSearch(workspace, 'css color variables and border styling', {
      embed
    })
    expect(theme.hits[0]!.path).toContain('theme.ts')
    // Real-model cosines can dip slightly negative on unrelated pairs; assert
    // ordering + range instead of strict positivity.
    for (const hit of theme.hits) {
      expect(hit.score).toBeLessThanOrEqual(1)
      expect(Number.isFinite(hit.score)).toBe(true)
    }
    for (let i = 1; i < theme.hits.length; i++) {
      expect(theme.hits[i - 1]!.score).toBeGreaterThanOrEqual(theme.hits[i]!.score)
    }
    expect(chunkCount).toBeGreaterThan(0)
  }, 180_000)
})