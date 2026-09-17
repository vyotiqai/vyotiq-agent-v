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

/**
 * Load the q8 MiniLM feature-extraction pipeline from a local model dir with
 * the exact semantics the utilityProcess uses (local-only, cacheDir pinned,
 * ORT thread hints for a utility context).
 */
export async function loadEmbedPipeline(modelDir: string): Promise<EmbedPipeline> {
  const intra = resolveOrtIntraOpThreads(undefined, 'utility')
  applyOrtThreadEnvHints(intra)
  const transformers = await import('@huggingface/transformers')
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