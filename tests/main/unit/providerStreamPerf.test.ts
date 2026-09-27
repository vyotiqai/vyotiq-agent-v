import { afterEach, describe, expect, it, vi } from 'vitest'
import { absorbOpenAiCompatThinkChunks } from '@main/agent/providers/openai'
import { iterateSseData } from '@main/agent/providers/sse'

// Structural guards for two per-chunk hot paths; wall-clock thresholds would
// flake on a loaded runner, so each test counts the work instead.

afterEach(() => {
  vi.restoreAllMocks()
})

describe('absorbOpenAiCompatThinkChunks cost per delta', () => {
  it('accumulates in place instead of re-cloning every chunk per delta', () => {
    let chunks = absorbOpenAiCompatThinkChunks([], [
      { text: 'a', thinking: [{ type: 'text', text: 'a' }] }
    ])
    const first = chunks
    for (let i = 0; i < 100; i++) {
      chunks = absorbOpenAiCompatThinkChunks(chunks, [
        { text: 'b', thinking: [{ type: 'text', text: 'b' }] }
      ])
    }
    expect(chunks).toBe(first)
    // Inner parts are kept one per delta (pinned in openaiStreamOptions.test.ts).
    expect(chunks[0]!.thinking).toHaveLength(101)
    expect(chunks[0]!.text).toBe(`a${'b'.repeat(100)}`)
  })

  it('does not alias the incoming frame', () => {
    const incoming = { text: 'x', thinking: [{ type: 'text', text: 'x' }] }
    const chunks = absorbOpenAiCompatThinkChunks([], [incoming])
    absorbOpenAiCompatThinkChunks(chunks, [{ text: 'y', thinking: [{ type: 'text', text: 'y' }] }])
    expect(incoming).toEqual({ text: 'x', thinking: [{ type: 'text', text: 'x' }] })
  })
})

describe('iterateSseData cost on one long line', () => {
  it('splits each byte once instead of re-splitting the partial line per read', async () => {
    const payload = 'x'.repeat(512 * 1024)
    const bytes = new TextEncoder().encode(`data: {"a":"${payload}"}\n\n`)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 4096) controller.enqueue(bytes.subarray(i, i + 4096))
        controller.close()
      }
    })
    const originalSplit = String.prototype.split
    let splitChars = 0
    vi.spyOn(String.prototype, 'split').mockImplementation(function (
      this: string,
      ...args: Parameters<typeof originalSplit>
    ) {
      splitChars += this.length
      return originalSplit.apply(this, args)
    } as typeof originalSplit)

    const out: string[] = []
    for await (const data of iterateSseData(new Response(stream), new AbortController().signal, {
      idleTimeoutMs: 0
    })) {
      out.push(data)
    }
    vi.restoreAllMocks()
    expect(out).toEqual([`{"a":"${payload}"}`])
    // 128 reads: re-splitting the growing buffer each read scans ~64x the payload.
    expect(splitChars).toBeLessThan(bytes.length * 2)
  })
})
