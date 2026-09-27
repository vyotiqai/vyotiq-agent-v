import type { ChatMessage, ContentPart, MessageContent } from '../../../shared/ipc'
import { providerContentParts } from '../../../shared/ipc'

type ImagePart = Extract<ContentPart, { type: 'image_url' }>

/**
 * A tool message's text and the images it carries, ready for a wire.
 *
 * Only images a provider can actually load are returned: hydrated data URLs
 * and http(s) links. `providerContentParts` turns anything else into a text
 * marker, which lands in `text` where the model can read it.
 */
export function splitToolContent(content: MessageContent): { text: string; images: ImagePart[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  const texts: string[] = []
  const images: ImagePart[] = []
  for (const part of providerContentParts(content, { image: true })) {
    if (part.type === 'image_url') images.push(part)
    else if (part.type === 'text') texts.push(part.text)
  }
  return { text: texts.join('\n'), images }
}

export function toolMessageHasImages(message: ChatMessage): boolean {
  return (
    message.role === 'tool' &&
    typeof message.content !== 'string' &&
    message.content.some((p) => p.type === 'image_url')
  )
}

function attachedNote(count: number): string {
  return count === 1
    ? '[1 image from this tool call is attached in the next message]'
    : `[${count} images from this tool call are attached in the next message]`
}

/**
 * For wires whose tool results cannot hold images (OpenAI Chat Completions,
 * Responses, both Gemini APIs): keep each tool result as text and follow the
 * run of tool results with one synthetic user turn carrying the images, each
 * labelled with the call that produced it. Providers already map user images.
 *
 * Returns the input array unchanged when no tool message carries an image.
 */
export function liftToolImagesToUserTurn(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some(toolMessageHasImages)) return messages
  const out: ChatMessage[] = []
  let pending: ContentPart[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    out.push({ role: 'user', synthetic: true, content: pending })
    pending = []
  }
  for (const message of messages) {
    if (message.role !== 'tool') {
      flush()
      out.push(message)
      continue
    }
    if (!toolMessageHasImages(message)) {
      out.push(message)
      continue
    }
    const { text, images } = splitToolContent(message.content)
    if (images.length === 0) {
      out.push({ ...message, content: text })
      continue
    }
    out.push({ ...message, content: `${text}\n\n${attachedNote(images.length)}` })
    const from = message.toolName ? `${message.toolName} (${message.toolCallId ?? 'call'})` : 'tool call'
    const noun = images.length === 1 ? 'Image' : `${images.length} images`
    pending.push({ type: 'text', text: `${noun} returned by ${from}:` })
    pending.push(...images)
  }
  flush()
  return out
}
