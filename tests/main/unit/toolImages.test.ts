import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatMessage, ContentPart } from '@shared/ipc'
import { providerContentParts, toolContentWithImages } from '@shared/ipc'
import {
  TOOL_IMAGE_MISSING_MARKER,
  TOOL_IMAGE_NO_VISION_MARKER,
  TOOL_IMAGE_OLDER_MARKER,
  clearToolImageCacheForTests,
  hydrateToolImages
} from '@main/agent/context/toolImages'
import { liftToolImagesToUserTurn } from '@main/agent/providers/toolImages'
import { toAnthropicMessages } from '@main/agent/providers/anthropic'
import { toOpenAiMessages } from '@main/agent/providers/openai'
import { toResponsesInput } from '@main/agent/providers/openaiResponses'
import { mcpResultContent } from '@main/agent/mcp'
import { toolReadImage } from '@main/agent/tools/read'
import { sniffImageFormat, storeToolImage } from '@main/agent/toolImageStore'

/** Smallest valid PNG header: signature + IHDR declaring 4x3. */
function png(width = 4, height = 3): Buffer {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

let runDir = ''

beforeEach(() => {
  clearToolImageCacheForTests()
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-tool-images-'))
})

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

function shot(name: string): string {
  const rel = `browser/${name}`
  mkdirSync(join(runDir, 'browser'), { recursive: true })
  writeFileSync(join(runDir, rel), JPEG)
  return rel
}

function toolMsg(id: string, artifacts: string[]): ChatMessage {
  return {
    role: 'tool',
    toolCallId: id,
    toolName: 'browser_snapshot',
    content: toolContentWithImages(
      `snapshot ${id}`,
      artifacts.map((artifact) => ({ artifact }))
    ),
    ok: true
  }
}

function parts(message: ChatMessage): ContentPart[] {
  return typeof message.content === 'string' ? [] : message.content
}

describe('hydrateToolImages', () => {
  it('loads the newest captures and marks the older ones', () => {
    const messages = [
      toolMsg('a', [shot('snapshot-1-1.jpg')]),
      toolMsg('b', [shot('snapshot-2-2.jpg')]),
      toolMsg('c', [shot('snapshot-3-3.jpg')])
    ]
    const out = hydrateToolImages(messages, runDir, { vision: true, keepLast: 2 })
    expect(out[0]!.content).toBe(`snapshot a\n${TOOL_IMAGE_OLDER_MARKER}`)
    for (const m of [out[1]!, out[2]!]) {
      const image = parts(m).find((p) => p.type === 'image_url')
      expect(image).toEqual({ type: 'image_url', url: `data:image/jpeg;base64,${JPEG.toString('base64')}` })
    }
    // What is persisted keeps the reference.
    expect(parts(messages[2]!)[1]).toMatchObject({ artifact: 'browser/snapshot-3-3.jpg' })
  })

  it('shows every frame of the newest burst, past the usual three', () => {
    const burst = ['1', '2', '3', '4', '5', '6'].map((n) => shot(`snapshot-9-${n}.jpg`))
    const messages = [toolMsg('old', [shot('snapshot-1-1.jpg')]), toolMsg('burst', burst)]
    const out = hydrateToolImages(messages, runDir, { vision: true })
    expect(parts(out[1]!).filter((p) => p.type === 'image_url')).toHaveLength(6)
    expect(out[0]!.content).toBe(`snapshot old\n${TOOL_IMAGE_OLDER_MARKER}`)
  })

  it('returns the same object while nothing about a message changed', () => {
    const messages = [toolMsg('a', [shot('snapshot-1-1.jpg')])]
    const first = hydrateToolImages(messages, runDir, { vision: true })
    const second = hydrateToolImages(messages, runDir, { vision: true })
    expect(second[0]).toBe(first[0])
  })

  it('never reads files for a model without vision', () => {
    const out = hydrateToolImages([toolMsg('a', ['browser/snapshot-9-9.jpg'])], runDir, {
      vision: false
    })
    expect(out[0]!.content).toBe(`snapshot a\n${TOOL_IMAGE_NO_VISION_MARKER}`)
  })

  it('says so when the file is gone', () => {
    const out = hydrateToolImages([toolMsg('a', ['browser/snapshot-7-7.jpg'])], runDir, {
      vision: true
    })
    expect(out[0]!.content).toBe(`snapshot a\n${TOOL_IMAGE_MISSING_MARKER}`)
  })

  it('leaves user attachments alone', () => {
    const user: ChatMessage = {
      role: 'user',
      content: [{ type: 'image_url', url: 'data:image/png;base64,AAAA' }]
    }
    expect(hydrateToolImages([user], runDir, { vision: true })[0]).toBe(user)
  })
})

describe('provider wire shapes', () => {
  const dataUrl = 'data:image/jpeg;base64,/9j/'
  const hydrated: ChatMessage[] = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'browser_snapshot', arguments: '{}' }]
    },
    {
      role: 'tool',
      toolCallId: 'call_1',
      toolName: 'browser_snapshot',
      ok: true,
      content: [
        { type: 'text', text: 'URL: https://example.com' },
        { type: 'image_url', url: dataUrl }
      ]
    }
  ]

  it('Anthropic keeps the image inside tool_result', () => {
    const { messages } = toAnthropicMessages(hydrated)
    const block = (messages[1]!.content as Array<Record<string, unknown>>)[0]!
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: [
        { type: 'text', text: 'URL: https://example.com' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } }
      ]
    })
  })

  it('Chat Completions answers the call in text, then shows the image as a user turn', () => {
    const wire = toOpenAiMessages(hydrated, undefined)
    const tool = wire.find((m) => m.role === 'tool')!
    expect(tool.content).toContain('URL: https://example.com')
    expect(tool.content).toContain('attached in the next message')
    const next = wire[wire.indexOf(tool) + 1]!
    expect(next.role).toBe('user')
    expect(next.content).toEqual([
      { type: 'text', text: 'Image returned by browser_snapshot (call_1):' },
      { type: 'image_url', image_url: { url: dataUrl } }
    ])
  })

  it('Responses follows function_call_output with an input_image', () => {
    const input = toResponsesInput(hydrated, undefined)
    const at = input.findIndex((item) => item.type === 'function_call_output')
    expect(input[at + 1]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'Image returned by browser_snapshot (call_1):' },
        { type: 'input_image', image_url: dataUrl }
      ]
    })
  })

  it('lifts once per run of tool results, after the last of them', () => {
    const lifted = liftToolImagesToUserTurn([
      ...hydrated,
      { role: 'tool', toolCallId: 'call_2', toolName: 'read', ok: true, content: 'text only' }
    ])
    expect(lifted.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
  })

  it('never puts an unhydrated reference on a wire', () => {
    const out = providerContentParts([
      { type: 'image_url', url: 'vyotiq-artifact:browser/snapshot-1-1.jpg', artifact: 'browser/snapshot-1-1.jpg' }
    ])
    expect(out).toEqual([{ type: 'text', text: '[screenshot not attached]' }])
  })
})

describe('tool image storage', () => {
  it('trusts the bytes over the declared type', () => {
    expect(sniffImageFormat(png())?.mime).toBe('image/png')
    expect(sniffImageFormat(Buffer.from('<svg/>'))).toBeNull()
  })

  it('stores an MCP image block instead of dumping its base64 as text', () => {
    const { text, images, notes } = mcpResultContent(
      [
        { type: 'text', text: 'Took a screenshot' },
        { type: 'image', data: png(800, 600).toString('base64'), mimeType: 'image/png' },
        { type: 'audio', data: 'QUJD', mimeType: 'audio/wav' }
      ],
      runDir
    )
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ width: 800, height: 600 })
    expect(images[0]!.artifact).toMatch(/^images\/mcp-\d+-\d+\.png$/)
    expect(notes[0]).toContain(images[0]!.artifact)
    expect(text).toContain('Took a screenshot')
    expect(text).not.toContain('QUJD')
  })

  it('summarises an embedded resource blob, and keeps an embedded resource text', () => {
    const blob = Buffer.alloc(3_000, 7).toString('base64')
    const { text } = mcpResultContent(
      [
        { type: 'resource', resource: { uri: 'file:///a.bin', mimeType: 'application/pdf', blob } },
        { type: 'resource', resource: { uri: 'file:///b.txt', text: 'plain body' } }
      ],
      runDir
    )
    expect(text).toContain('[resource uri=file:///a.bin mime=application/pdf bytes=3000]')
    expect(text).not.toContain(blob.slice(0, 64))
    expect(text).toContain('plain body')
  })

  it('refuses an image no provider would accept', () => {
    const result = storeToolImage(runDir, png(9000, 10), { source: 'mcp' })
    expect(result.ok).toBe(false)
  })

  it('reads a workspace image as an image', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-read-image-'))
    try {
      writeFileSync(join(workspace, 'shot.png'), png(640, 480))
      const { content, image } = await toolReadImage(workspace, 'shot.png', runDir)
      expect(content).toContain('640x480')
      expect(image).toMatchObject({ width: 640, height: 480, label: 'shot.png' })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
