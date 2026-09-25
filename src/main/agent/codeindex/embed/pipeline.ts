/**
 * Real embedding-pipeline loader, shared by the embedUtility entry and the
 * dedicated e2e test. Keep this the ONLY place transformers/ORT load code
 * lives; never import it from main-reachable module paths.
 */
import {
  applyOrtThreadEnvHints,
  buildOrtSessionOptions,
  resolveOrtIntraOpThreads
} from '../../../dictation/ortSessionOptions'

export type EmbedPipeline = (
  text: string,
  opts: { pooling: 'mean'; normalize: true }
) => Promise<{ data: Float32Array } & Record<string, unknown>>

type TransformersModule = typeof import('@huggingface/transformers')

/**
 * Actionable diagnosis for a failed transformers.js resolve.
 *
 * The bare `import('@huggingface/transformers')` below is resolved by Node ESM
 * relative to the ROLLUP OUTPUT (`out/main/embedUtility.js` in dev,
 * `app.asar/out/main/embedUtility.js` packaged) — both layouts resolve the
 * whole module graph whenever `node_modules` is intact (repro'd both ways in
 * scratch/w2-findings.md). The one observed failure mode is the package being
 * absent from every node_modules ancestor (stale/partial install) — surface
 * that as one actionable warn instead of 27 bare ERR_MODULE_NOT_FOUND lines.
 */
export function explainTransformersResolveError(err: unknown): Error {
  const code = (err as { code?: string } | null | undefined)?.code
  if (err instanceof Error && (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND')) {
    return new Error(
      'Embedding pipeline unavailable: cannot resolve "@huggingface/transformers" from the ' +
        'embedding utility (node_modules missing or incomplete). Run `pnpm install` (dev) or ' +
        'reinstall the app (packaged); dense vector indexing stays off until the package ' +
        `resolves. Original error: ${err.message}`
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Load the transformers.js module graph. Kept as a bare dynamic import of an
 * externalized dependency (see electron.vite.config.ts main build) — the
 * emitted `import("@huggingface/transformers")` is exactly what the dev and
 * packaged resolution repros exercise.
 */
export async function importTransformersModule(): Promise<TransformersModule> {
  try {
    return await import('@huggingface/transformers')
  } catch (err) {
    throw explainTransformersResolveError(err)
  }
}

/**
 * Load the q8 MiniLM feature-extraction pipeline from a local model dir with
 * the exact semantics the utilityProcess uses (local-only, cacheDir pinned,
 * ORT thread hints for a utility context).
 */
export async function loadEmbedPipeline(modelDir: string): Promise<EmbedPipeline> {
  const intra = resolveOrtIntraOpThreads(undefined, 'utility')
  applyOrtThreadEnvHints(intra)
  const transformers = await importTransformersModule()
  const { env, pipeline } = transformers
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.useBrowserCache = false
  ;(env as { cacheDir?: string }).cacheDir = modelDir

  const asr = (await pipeline('feature-extraction', modelDir, {
    local_files_only: true,
    dtype: 'q8',
    session_options: buildOrtSessionOptions(undefined, 'utility')
  })) as unknown as EmbedPipeline

  return asr
}