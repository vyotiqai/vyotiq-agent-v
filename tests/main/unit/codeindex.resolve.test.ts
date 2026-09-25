/**
 * Resolution guard for the codeindex embedding pipeline's transformers.js
 * import graph — the regression test for the 2026-09-22 incident where every
 * dense vector warm job failed with:
 *   "Cannot find package '@huggingface/transformers' imported from embedUtility.js"
 * because node_modules lacked the package (stale/partial install).
 *
 * The production import shape is a bare dynamic import resolved from the
 * rollup output directory (out/main/ dev, app.asar/out/main/ packaged). Both
 * layouts resolve the whole module graph when node_modules is intact; this
 * suite fails fast when it is not, and pins the actionable error for when the
 * resolve still fails.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  explainTransformersResolveError,
  importTransformersModule
} from '@main/agent/codeindex/embed/pipeline'

describe('codeindex embedding resolution', () => {
  it('resolves the @huggingface/transformers node entry to a real file', () => {
    const require = createRequire(import.meta.url)
    const resolved = require.resolve('@huggingface/transformers')
    // node.require export — the CJS side of the same package the ESM import
    // resolves via node.import (dist/transformers.node.mjs).
    expect(resolved.endsWith('transformers.node.cjs')).toBe(true)
    expect(existsSync(resolved)).toBe(true)
  })

  it('loads the whole transformers pipeline via the bare dynamic import', async () => {
    // The exact specifier + shape the utility uses: proves module graph
    // resolution (onnxruntime-node / sharp included), not just package lookup.
    const transformers = await importTransformersModule()
    expect(typeof transformers.pipeline).toBe('function')
    expect(typeof transformers.env).toBe('object')
  }, 60_000)

  it('maps a missing-package resolve failure to one actionable error', () => {
    const raw = Object.assign(
      new Error("Cannot find package '@huggingface/transformers' imported from embedUtility.js"),
      { code: 'ERR_MODULE_NOT_FOUND' }
    )
    const mapped = explainTransformersResolveError(raw)
    expect(mapped).toBeInstanceOf(Error)
    expect(mapped).not.toBe(raw)
    expect(mapped.message).toContain('@huggingface/transformers')
    expect(mapped.message).toContain('pnpm install')
    // The verbatim production error stays in the message for triage.
    expect(mapped.message).toContain("Cannot find package '@huggingface/transformers'")
  })

  it('passes non-resolve errors through unchanged', () => {
    const raw = new Error('sharp native binding failed to load')
    expect(explainTransformersResolveError(raw)).toBe(raw)
    const nonError = explainTransformersResolveError('boom')
    expect(nonError).toBeInstanceOf(Error)
    expect(nonError.message).toBe('boom')
  })
})
