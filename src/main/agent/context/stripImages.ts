import type { ChatMessage, ContentPart, ModelInfo } from '../../../shared/ipc'
import { providerContentParts, type ProviderWireCaps } from '../../../shared/ipc'

export function wireCapsFromModel(model: ModelInfo): ProviderWireCaps {
  const mods = model.inputModalities ?? []
  return {
    image: Boolean(model.supportsVision || mods.includes('image')),
    audio: mods.includes('audio'),
    fileNative: mods.includes('file')
  }
}

/** Providers reject requests carrying more than this many image parts (400: "Image count N exceeds limit 8 per request"). */
export const MAX_IMAGES_PER_REQUEST = 8

export const IMAGE_CAP_OMISSION_MARKER =
  '[image omitted: earlier attachment dropped to stay under the 8-image provider limit]'

/**
 * Cap image parts per outgoing provider request. Keeps the most recent
 * `maxImages` image parts by transcript position and replaces each older one
 * with a short text marker. Only caps when images survive stripping — when
 * the model does not support them, stripUnsupportedModalitiesFromMessages
 * has already replaced every image part with a text marker.
 */
export function capImagesPerRequest(
  messages: ChatMessage[],
  caps: ProviderWireCaps,
  maxImages: number = MAX_IMAGES_PER_REQUEST
): ChatMessage[] {
  if (caps.image === false || maxImages < 1) return messages
  const totalImages = messages.reduce((n, m) => {
    if (typeof m.content === 'string') return n
    return n + m.content.filter((p) => p.type === 'image_url').length
  }, 0)
  let over = totalImages - maxImages
  if (over <= 0) return messages
  return messages.map((m) => {
    if (typeof m.content === 'string' || over <= 0) return m
    if (!m.content.some((p) => p.type === 'image_url')) return m
    const parts = m.content.map((p) => {
      if (p.type === 'image_url' && over > 0) {
        over -= 1
        return { type: 'text' as const, text: IMAGE_CAP_OMISSION_MARKER }
      }
      return p
    })
    return withCollapsedTextParts(m, parts)
  })
}

/**
 * Once every part is text the message no longer needs the array shape — a plain
 * string keeps the wire payload, and the token estimate, closer to what the
 * model actually receives.
 */
function withCollapsedTextParts<P extends ContentPart>(
  message: ChatMessage,
  parts: P[]
): ChatMessage {
  if (!parts.every((p) => p.type === 'text')) return { ...message, content: parts }
  return {
    ...message,
    content: parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
}

/** Replace unsupported multimodal parts with text markers before send/estimate. */
export function stripUnsupportedModalitiesFromMessages(
  messages: ChatMessage[],
  caps: ProviderWireCaps
): ChatMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return m
    const hasRich = m.content.some(
      (p) =>
        p.type === 'image_url' ||
        p.type === 'audio' ||
        p.type === 'file_native' ||
        p.type === 'file'
    )
    if (!hasRich) return m
    const parts = providerContentParts(m.content, caps)
    return withCollapsedTextParts(m, parts)
  })
}
