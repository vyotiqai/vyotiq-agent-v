import { beforeEach, describe, expect, it } from 'vitest'
import { deflateSync } from 'zlib'
import {
  countTextTokens,
  countTextTokensAsync,
  countTextsTokensAsync,
  encodingForModel,
  resetTokenizerCache
} from '@main/agent/context/tokenizer'
import { resetTokenizerPoolForTests } from '@main/agent/context/tokenizerPool'
import {
  DEFAULT_IMAGE_TOKENS,
  estimateImageTokens,
  imageDimensionsFromDataUrl,
  imageTokensForDimensions
} from '@main/agent/context/imageTokens'
import {
  estimateMessagesTokensAsync,
  estimateTextTokens
} from '@main/agent/context/estimate'
import type { ModelInfo } from '@shared/ipc'

function model(id: string): ModelInfo {
  return {
    id,
    displayName: id,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsVision: true
  }
}

/** Minimal valid PNG: signature + IHDR chunk + a stub IDAT/IEND. */
function pngDataUrl(width: number, height: number): string {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrBody = Buffer.alloc(13)
  ihdrBody.writeUInt32BE(width, 0)
  ihdrBody.writeUInt32BE(height, 4)
  ihdrBody[8] = 8
  ihdrBody[9] = 6
  const ihdr = Buffer.concat([
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR', 'ascii'),
    ihdrBody,
    Buffer.alloc(4)
  ])
  const idatBody = deflateSync(Buffer.alloc(4))
  const idat = Buffer.concat([
    (() => {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(idatBody.length)
      return len
    })(),
    Buffer.from('IDAT', 'ascii'),
    idatBody,
    Buffer.alloc(4)
  ])
  const png = Buffer.concat([signature, ihdr, idat])
  return `data:image/png;base64,${png.toString('base64')}`
}

function gifDataUrl(width: number, height: number): string {
  const buf = Buffer.alloc(14)
  buf.write('GIF89a', 0, 'ascii')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return `data:image/gif;base64,${buf.toString('base64')}`
}

function jpegDataUrl(width: number, height: number): string {
  // SOI, an APP0 segment to skip over, then SOF0 carrying the real dimensions.
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'ascii'),
    Buffer.alloc(9)
  ])
  const sof = Buffer.alloc(11)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(9, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}

describe('countTextTokens', () => {
  beforeEach(() => {
    resetTokenizerCache()
    resetTokenizerPoolForTests()
  })

  it('counts real BPE tokens rather than dividing by four', () => {
    // 11 characters that the heuristic would call 3 tokens.
    expect(countTextTokens('hello world')).toBe(2)
  })

  it('returns zero for empty text', () => {
    expect(countTextTokens('')).toBe(0)
  })

  it('is stable across repeated calls through the cache', () => {
    const first = countTextTokens('the quick brown fox jumps over the lazy dog')
    const second = countTextTokens('the quick brown fox jumps over the lazy dog')
    expect(second).toBe(first)
    expect(first).toBeGreaterThan(5)
  })

  it('falls back to the heuristic beyond the large-text threshold', () => {
    const huge = 'a'.repeat(120_000)
    expect(countTextTokens(huge)).toBe(30_000)
  })

  it('handles unicode without throwing', () => {
    expect(countTextTokens('日本語のテキスト 🎉')).toBeGreaterThan(0)
  })
})

describe('countTextTokensAsync', () => {
  beforeEach(() => {
    resetTokenizerCache()
    resetTokenizerPoolForTests()
  })

  it('matches sync BPE counts (worker or sync fallback)', async () => {
    const text = 'the quick brown fox jumps over the lazy dog'
    await expect(countTextTokensAsync(text)).resolves.toBe(countTextTokens(text))
  })

  it('batches mixed encodings and empties', async () => {
    const counts = await countTextsTokensAsync([
      { text: '', encoding: 'o200k_base' },
      { text: 'hello world', encoding: 'o200k_base' },
      { text: 'hello world', encoding: 'cl100k_base' }
    ])
    expect(counts[0]).toBe(0)
    expect(counts[1]).toBe(countTextTokens('hello world', 'o200k_base'))
    expect(counts[2]).toBe(countTextTokens('hello world', 'cl100k_base'))
  })

  it('uses the large-text heuristic without encoding', async () => {
    const huge = 'a'.repeat(120_000)
    await expect(countTextTokensAsync(huge)).resolves.toBe(30_000)
  })
})

describe('encodingForModel', () => {
  it('uses cl100k for pre-4o OpenAI models', () => {
    expect(encodingForModel(model('gpt-4'))).toBe('cl100k_base')
    expect(encodingForModel(model('gpt-4-turbo'))).toBe('cl100k_base')
    expect(encodingForModel(model('gpt-3.5-turbo'))).toBe('cl100k_base')
  })

  it('uses o200k for modern and non-OpenAI models', () => {
    expect(encodingForModel(model('gpt-4o'))).toBe('o200k_base')
    expect(encodingForModel(model('gpt-4.1'))).toBe('o200k_base')
    expect(encodingForModel(model('gpt-5'))).toBe('o200k_base')
    expect(encodingForModel(model('claude-sonnet-4'))).toBe('o200k_base')
    expect(encodingForModel(undefined)).toBe('o200k_base')
  })
})

describe('image dimensions', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    expect(imageDimensionsFromDataUrl(pngDataUrl(1920, 1080))).toEqual({
      width: 1920,
      height: 1080
    })
  })

  it('reads GIF dimensions', () => {
    expect(imageDimensionsFromDataUrl(gifDataUrl(320, 240))).toEqual({ width: 320, height: 240 })
  })

  it('reads JPEG dimensions past an APP0 segment', () => {
    expect(imageDimensionsFromDataUrl(jpegDataUrl(800, 600))).toEqual({ width: 800, height: 600 })
  })

  it('returns null for a non-data URL', () => {
    expect(imageDimensionsFromDataUrl('https://example.com/a.png')).toBeNull()
  })

  it('returns null for undecodable content', () => {
    expect(imageDimensionsFromDataUrl('data:image/png;base64,zzzz')).toBeNull()
  })
})

describe('imageTokensForDimensions', () => {
  it('charges a single tile for a small icon', () => {
    expect(imageTokensForDimensions(64, 64)).toBe(85 + 170)
  })

  it('charges four tiles for a 1024x768 screenshot', () => {
    expect(imageTokensForDimensions(1024, 768)).toBe(85 + 170 * 4)
  })

  it('scales oversized images down before tiling', () => {
    // 4096x4096 fits to 2048, then the shortest side drops to 768 -> 4 tiles.
    expect(imageTokensForDimensions(4096, 4096)).toBe(85 + 170 * 4)
  })

  it('distinguishes an icon from a screenshot', () => {
    expect(imageTokensForDimensions(64, 64)).toBeLessThan(imageTokensForDimensions(1920, 1080))
  })
})

describe('estimateImageTokens', () => {
  it('uses parsed dimensions when available', () => {
    expect(estimateImageTokens(pngDataUrl(64, 64))).toBe(255)
  })

  it('falls back to the screenshot default when dimensions are unreadable', () => {
    expect(estimateImageTokens('https://example.com/photo.jpg')).toBe(DEFAULT_IMAGE_TOKENS)
  })
})

describe('estimateMessagesTokensAsync', () => {
  it('counts image parts by dimension rather than a flat constant', async () => {
    const icon = await estimateMessagesTokensAsync([
      { role: 'user', content: [{ type: 'image_url', url: pngDataUrl(64, 64) }] }
    ])
    const large = await estimateMessagesTokensAsync([
      { role: 'user', content: [{ type: 'image_url', url: pngDataUrl(1920, 1080) }] }
    ])
    expect(icon).toBeLessThan(large)
  })

  it('includes tool call arguments and thinking text', async () => {
    const bare = await estimateMessagesTokensAsync([{ role: 'assistant', content: 'ok' }])
    const rich = await estimateMessagesTokensAsync([
      {
        role: 'assistant',
        content: 'ok',
        thinking: 'a long chain of reasoning about the problem',
        toolCalls: [{ id: 't1', name: 'read', arguments: '{"path":"src/index.ts"}' }]
      }
    ])
    expect(rich).toBeGreaterThan(bare)
  })

  it('does not double-count thinking when reasoningState is present', async () => {
    const longThink = 'a long chain of reasoning about the problem '.repeat(20)
    const withBoth = await estimateMessagesTokensAsync([
      {
        role: 'assistant',
        content: 'ok',
        thinking: longThink,
        reasoningState: { kind: 'openai_compat', reasoningContent: longThink }
      }
    ])
    const stateOnly = await estimateMessagesTokensAsync([
      {
        role: 'assistant',
        content: 'ok',
        reasoningState: { kind: 'openai_compat', reasoningContent: longThink }
      }
    ])
    expect(withBoth).toBe(stateOnly)
  })

  it('counts tool message content once (not double-counted with toolName)', async () => {
    const body = 'TOOL_BODY_'.repeat(50)
    const withTool = await estimateMessagesTokensAsync([
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: body }
    ])
    const contentOnly = await estimateMessagesTokensAsync([{ role: 'user', content: body }])
    const nameOnly = await estimateMessagesTokensAsync([
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: '' }
    ])
    // content + toolName, not 2x content + toolName
    expect(withTool).toBeLessThan(contentOnly * 2)
    expect(withTool).toBeGreaterThan(contentOnly)
    expect(withTool).toBeGreaterThan(nameOnly)
  })

  it('selects the encoding from the model', () => {
    const text = 'tokenization differs subtly between encodings'
    expect(estimateTextTokens(text, model('gpt-4'))).toBeGreaterThan(0)
    expect(estimateTextTokens(text, model('gpt-4o'))).toBeGreaterThan(0)
  })

  it('reuses the per-message cache across repeated counts of the same array', async () => {
    resetTokenizerCache()
    const messages = [
      {
        role: 'assistant' as const,
        content: 'ok',
        thinking: 'a long chain of reasoning about the problem',
        toolCalls: [{ id: 't1', name: 'read', arguments: '{"path":"src/index.ts"}' }]
      }
    ]
    const first = await estimateMessagesTokensAsync(messages, model('gpt-4o'))
    const second = await estimateMessagesTokensAsync(messages, model('gpt-4o'))
    expect(second).toBe(first)
  })
})
