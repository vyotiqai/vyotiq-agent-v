import { readFileSync } from 'fs'
import { join } from 'path'
import type { ChatMessage, ContentPart } from '../../../shared/ipc'
import { runArtifactImageMime } from '../../../shared/ipc'
import { SNIP_MAX_FRAMES } from '../../app/snipLimits'

/**
 * Tool screenshots the model sees at once. Each is ~1k input tokens and is
 * re-sent every step, and only the newest captures describe the page as it is
 * now; older ones become a marker telling the model how to get a fresh one.
 */
export const KEEP_LAST_TOOL_IMAGES = 3

/** Anthropic's per-image ceiling; a larger file would fail the whole request. */
export const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024

export const TOOL_IMAGE_OLDER_MARKER =
  '[screenshot omitted: older capture. Take a new screenshot to see the current state.]'
export const TOOL_IMAGE_MISSING_MARKER =
  '[screenshot unavailable: the image file is no longer in the run directory]'
export const TOOL_IMAGE_NO_VISION_MARKER =
  '[screenshot captured but not shown: this model does not accept images; rely on the text above]'

type Disposition = 'show' | 'older' | 'novision' | 'missing'

const DATA_URL_CACHE_MAX = 16
/** Recent data URLs by absolute path; screenshots are immutable once written. */
const dataUrlCache = new Map<string, string>()

function readArtifactDataUrl(runDir: string, artifact: string): string | null {
  const mime = runArtifactImageMime(artifact)
  if (!mime) return null
  const abs = join(runDir, artifact)
  const cached = dataUrlCache.get(abs)
  if (cached) {
    dataUrlCache.delete(abs)
    dataUrlCache.set(abs, cached)
    return cached
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(abs)
  } catch {
    return null
  }
  if (bytes.length === 0 || bytes.length > MAX_TOOL_IMAGE_BYTES) return null
  const url = `data:${mime};base64,${bytes.toString('base64')}`
  dataUrlCache.set(abs, url)
  while (dataUrlCache.size > DATA_URL_CACHE_MAX) {
    const oldest = dataUrlCache.keys().next().value
    if (oldest === undefined) break
    dataUrlCache.delete(oldest)
  }
  return url
}

/** Per message: the dispositions it was hydrated with, and the result. */
const hydratedByMessage = new WeakMap<ChatMessage, { key: string; out: ChatMessage }>()

function markerFor(disposition: Exclude<Disposition, 'show'>): string {
  if (disposition === 'older') return TOOL_IMAGE_OLDER_MARKER
  if (disposition === 'novision') return TOOL_IMAGE_NO_VISION_MARKER
  return TOOL_IMAGE_MISSING_MARKER
}

/**
 * Swap tool-image references (`vyotiq-artifact:` URLs) for data URLs on the
 * request copy of the history.
 *
 * The newest `keepLast` tool images are loaded from the run dir — or, when the
 * newest tool result is a burst, every frame of it, since a sequence cut to
 * its last three frames no longer shows the motion it was taken for. Older ones,
 * and every one when the model has no vision, become short text markers. The
 * transcript on disk keeps the references, so this never changes what is
 * persisted. A message whose dispositions did not change since the last step
 * returns the same object, which keeps the per-message token cache warm.
 */
export function hydrateToolImages(
  messages: ChatMessage[],
  runDir: string | undefined,
  opts: { vision: boolean; keepLast?: number }
): ChatMessage[] {
  const keepLast = opts.keepLast ?? KEEP_LAST_TOOL_IMAGES
  let budget: number | undefined
  let shown = 0
  // Walk newest-first so the kept window is the most recent captures.
  const plans = new Map<number, Disposition[]>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content
    if (typeof content === 'string') continue
    const refs = content.filter((p) => p.type === 'image_url' && p.artifact)
    if (refs.length === 0) continue
    const plan: Disposition[] = new Array(refs.length)
    budget ??= Math.max(keepLast, Math.min(refs.length, SNIP_MAX_FRAMES))
    for (let j = refs.length - 1; j >= 0; j--) {
      if (!opts.vision) plan[j] = 'novision'
      else if (shown < budget) {
        plan[j] = 'show'
        shown += 1
      } else plan[j] = 'older'
    }
    plans.set(i, plan)
  }
  if (plans.size === 0) return messages

  return messages.map((message, i) => {
    const plan = plans.get(i)
    if (!plan) return message
    const content = message.content as ContentPart[]
    // Resolve before keying so a file deleted mid-run changes the key.
    const urls: Array<string | null> = []
    let r = 0
    for (const part of content) {
      if (part.type !== 'image_url' || !part.artifact) continue
      const disposition = plan[r]!
      if (disposition === 'show') {
        const url = runDir ? readArtifactDataUrl(runDir, part.artifact) : null
        if (!url) plan[r] = 'missing'
        urls.push(url)
      } else {
        urls.push(null)
      }
      r += 1
    }
    const key = plan.join(',')
    const prior = hydratedByMessage.get(message)
    if (prior && prior.key === key) return prior.out

    const parts: ContentPart[] = []
    r = 0
    for (const part of content) {
      if (part.type !== 'image_url' || !part.artifact) {
        parts.push(part)
        continue
      }
      const disposition = plan[r]!
      const url = urls[r]
      r += 1
      if (disposition === 'show' && url) {
        parts.push({ type: 'image_url', url })
      } else {
        parts.push({ type: 'text', text: markerFor(disposition === 'show' ? 'missing' : disposition) })
      }
    }
    const allText = parts.every((p) => p.type === 'text')
    const out: ChatMessage = {
      ...message,
      content: allText
        ? parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
        : parts
    }
    hydratedByMessage.set(message, { key, out })
    return out
  })
}

/** Test hook: forget cached image bytes. */
export function clearToolImageCacheForTests(): void {
  dataUrlCache.clear()
}
