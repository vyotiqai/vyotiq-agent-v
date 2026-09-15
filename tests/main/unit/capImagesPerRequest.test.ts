import { describe, expect, it } from 'vitest'
import {
  capImagesPerRequest,
  IMAGE_CAP_OMISSION_MARKER,
  MAX_IMAGES_PER_REQUEST
} from '@main/agent/context/stripImages'
import type { ChatMessage, ContentPart } from '@shared/ipc'

const caps = { image: true }

const image = (n: number): ContentPart => ({
  type: 'image_url',
  url: `data:image/png;base64,IMG${n}`
})
const text = (t: string): ContentPart => ({ type: 'text', text: t })

const user = (parts: ContentPart[]): ChatMessage => ({ role: 'user', content: parts })

const countImages = (messages: ChatMessage[]): number =>
  messages.reduce(
    (n, m) =>
      typeof m.content === 'string'
        ? n
        : n + m.content.filter((p) => p.type === 'image_url').length,
    0
  )

const countMarkers = (messages: ChatMessage[]): number =>
  messages.reduce((n, m) => {
    if (typeof m.content === 'string') {
      // Whole message collapses to text (same convention as modality stripping).
      return n + m.content.split(IMAGE_CAP_OMISSION_MARKER).length - 1
    }
    return (
      n +
      m.content.filter(
        (p) => p.type === 'text' && p.text === IMAGE_CAP_OMISSION_MARKER
      ).length
    )
  }, 0)

describe('capImagesPerRequest', () => {
  it('keeps the most recent 8 images and replaces each older one with a marker', () => {
    const messages: ChatMessage[] = [
      user([text('first batch'), image(1), image(2), image(3), image(4)]),
      user([text('second batch'), image(5), image(6), image(7), image(8)]),
      user([text('third batch'), image(9), image(10), image(11), image(12)])
    ]
    const capped = capImagesPerRequest(messages, caps)

    expect(countImages(capped)).toBe(MAX_IMAGES_PER_REQUEST)
    expect(countMarkers(capped)).toBe(4)

    // Oldest four (IMG1-IMG4) are dropped; newest eight survive, in order.
    const keptUrls = capped.flatMap((m) =>
      typeof m.content === 'string'
        ? []
        : m.content
            .filter((p) => p.type === 'image_url')
            .map((p) => (p.type === 'image_url' ? p.url : ''))
    )
    expect(keptUrls).toEqual(
      [5, 6, 7, 8, 9, 10, 11, 12].map((n) => `data:image/png;base64,IMG${n}`)
    )
  })

  it('leaves a request with at most 8 images unchanged', () => {
    const messages: ChatMessage[] = [
      user([text('some'), image(1), image(2), image(3)]),
      user([image(4), image(5), image(6)])
    ]
    expect(capImagesPerRequest(messages, caps)).toEqual(messages)
  })

  it('does not cap when the model does not support images (they are stripped already)', () => {
    const messages: ChatMessage[] = [user([image(1), image(2), image(3)])]
    expect(capImagesPerRequest(messages, { image: false })).toEqual(messages)
  })
})
