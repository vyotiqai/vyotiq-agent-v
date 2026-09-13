import { createHash } from 'node:crypto'
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base'
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base'
import type { ModelInfo } from '../../../shared/ipc/schemas/providers'
import { encodeCountsInWorker } from './tokenizerPool'

export type EncodingName = 'o200k_base' | 'cl100k_base'

/**
 * Running a real BPE over a megabyte of tool output costs more than the
 * accuracy is worth, so anything past this falls back to the chars/4 heuristic.
 */
const LARGE_TEXT_CHARS = 100_000
const HEURISTIC_CHARS_PER_TOKEN = 4

/**
 * Assembly re-counts the whole history on every step. Small strings keep the
 * text as the key (cheap + pointer-shareable). Larger strings use a length+hash
 * key so the Map does not pin full tool bodies after messages can GC.
 */
const CACHE_LIMIT = 4000
/** Above this, cache by hash instead of retaining the full string as a Map key. */
const INLINE_KEY_CHARS = 256
const cache = new Map<string, number>()

type TokenizerPerfStats = {
  workerBatches: number
  workerItems: number
  syncFallbacks: number
  cacheHits: number
  heuristicLarge: number
  /** Cumulative ms spent awaiting worker / sync encode for misses. */
  encodeMs: number
}

let tokenizerPerf: TokenizerPerfStats = {
  workerBatches: 0,
  workerItems: 0,
  syncFallbacks: 0,
  cacheHits: 0,
  heuristicLarge: 0,
  encodeMs: 0
}

export function getTokenizerPerfStats(): TokenizerPerfStats {
  return { ...tokenizerPerf }
}

export function resetTokenizerPerfStats(): void {
  tokenizerPerf = {
    workerBatches: 0,
    workerItems: 0,
    syncFallbacks: 0,
    cacheHits: 0,
    heuristicLarge: 0,
    encodeMs: 0
  }
}

/** Only OpenAI models predating gpt-4o still use cl100k. */
export function encodingForModel(model?: ModelInfo): EncodingName {
  const id = model?.id ?? ''
  if (/^(gpt-4(?!o|\.|-?1)|gpt-3\.5|text-davinci)/i.test(id)) return 'cl100k_base'
  return 'o200k_base'
}

function cacheKey(encoding: EncodingName, text: string): string {
  if (text.length <= INLINE_KEY_CHARS) {
    return encoding === 'o200k_base' ? text : `${encoding}\u0000${text}`
  }
  const digest = createHash('sha256').update(text).digest('base64url').slice(0, 24)
  return `${encoding}\u0000${text.length}\u0000${digest}`
}

function encodeWith(encoding: EncodingName, text: string): number {
  return encoding === 'cl100k_base' ? encodeCl100k(text).length : encodeO200k(text).length
}

function remember(key: string, count: number): number {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, count)
  return count
}

function countUncachedSync(text: string, encoding: EncodingName): number {
  try {
    return encodeWith(encoding, text)
  } catch {
    // A malformed lone surrogate can throw; the heuristic is better than crashing.
    return Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN)
  }
}

/**
 * Sync BPE count. Prefer `countTextTokensAsync` on agent hot paths so concurrent
 * runs do not peg the Electron main thread.
 */
export function countTextTokens(text: string, encoding: EncodingName = 'o200k_base'): number {
  if (!text) return 0
  if (text.length > LARGE_TEXT_CHARS) {
    return Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN)
  }

  const key = cacheKey(encoding, text)
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  return remember(key, countUncachedSync(text, encoding))
}

/**
 * Same semantics as `countTextTokens`, but uncached BPE runs in a worker pool
 * when the built worker script is available.
 */
export async function countTextTokensAsync(
  text: string,
  encoding: EncodingName = 'o200k_base'
): Promise<number> {
  const [count] = await countTextsTokensAsync([{ text, encoding }])
  return count ?? 0
}

/** Batch uncached BPE encodes into one worker round-trip when possible. */
export async function countTextsTokensAsync(
  items: Array<{ text: string; encoding: EncodingName }>
): Promise<number[]> {
  const out = new Array<number>(items.length)
  const missIdx: number[] = []
  const missItems: Array<{ text: string; encoding: EncodingName }> = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (!item.text) {
      out[i] = 0
      continue
    }
    if (item.text.length > LARGE_TEXT_CHARS) {
      tokenizerPerf.heuristicLarge += 1
      out[i] = Math.ceil(item.text.length / HEURISTIC_CHARS_PER_TOKEN)
      continue
    }
    const key = cacheKey(item.encoding, item.text)
    const cached = cache.get(key)
    if (cached !== undefined) {
      tokenizerPerf.cacheHits += 1
      out[i] = cached
      continue
    }
    missIdx.push(i)
    missItems.push(item)
  }

  if (missItems.length === 0) return out

  const started = performance.now()
  let counts: number[] | null = null
  try {
    counts = await encodeCountsInWorker(missItems)
  } catch {
    counts = null
  }

  if (counts) {
    tokenizerPerf.workerBatches += 1
    tokenizerPerf.workerItems += missItems.length
  } else {
    tokenizerPerf.syncFallbacks += 1
  }
  tokenizerPerf.encodeMs += performance.now() - started

  for (let j = 0; j < missItems.length; j++) {
    const item = missItems[j]!
    const idx = missIdx[j]!
    const key = cacheKey(item.encoding, item.text)
    const count =
      counts && counts[j] !== undefined ? counts[j]! : countUncachedSync(item.text, item.encoding)
    out[idx] = remember(key, count)
  }

  return out
}

/** Exposed for tests; the cache is otherwise process-lifetime. */
export function resetTokenizerCache(): void {
  cache.clear()
}

/** Test helper: true if any Map key literally contains `needle`. */
export function tokenizerCacheKeyContains(needle: string): boolean {
  for (const key of cache.keys()) {
    if (key.includes(needle)) return true
  }
  return false
}
