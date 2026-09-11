import { describe, expect, it } from 'vitest'
import {
  clsPoolLastHidden,
  embedBatchedOnnx,
  ONNX_EMBED_MAX_BATCH
} from '@main/agent/codeindex/onnxEmbed'

describe('clsPoolLastHidden', () => {
  it('takes the CLS token of each row in [batch, seq, hidden] and L2-normalizes', () => {
    // batch=2, seq=3, hidden=4
    const hidden = 4
    const seq = 3
    const data = new Float32Array([
      3, 0, 0, 0, 9, 9, 9, 9, 8, 8, 8, 8, // batch 0
      0, 4, 0, 0, 7, 7, 7, 7, 6, 6, 6, 6 // batch 1
    ])
    const out = clsPoolLastHidden(data, [2, seq, hidden], hidden, 2)
    expect(out).toHaveLength(2)
    expect([...out[0]!]).toEqual([1, 0, 0, 0])
    expect([...out[1]!]).toEqual([0, 1, 0, 0])
  })

  it('treats [seq, hidden] as a single sequence (first token)', () => {
    const data = new Float32Array([0, 5, 0, 0, 1, 1, 1, 1])
    const out = clsPoolLastHidden(data, [2, 4], 4, 1)
    expect(out).toHaveLength(1)
    expect([...out[0]!]).toEqual([0, 1, 0, 0])
  })
})

describe('embedBatchedOnnx input guards', () => {
  function fakeTokenizer(): (
    text: string | string[]
  ) => Promise<{ input_ids: { data: BigInt64Array; dims: number[] } }> {
    return async (text: string | string[]) => {
      const list = Array.isArray(text) ? text : [text]
      const data = new BigInt64Array(list.length)
      for (let i = 0; i < list.length; i++) data[i] = 1n
      return { input_ids: { data, dims: [list.length, 1] } }
    }
  }

  it('chunks oversized requests so one forward never exceeds the max batch', async () => {
    const batches: number[] = []
    const hidden = 2
    const total = ONNX_EMBED_MAX_BATCH * 3 + 5
    const model = async (inputs: unknown) => {
      const t = inputs as { input_ids: { dims: number[] } }
      const b = t.input_ids.dims[0]!
      batches.push(b)
      return { last_hidden_state: { data: new Float32Array(b * hidden).fill(1), dims: [b, 1, hidden] } }
    }
    const out = await embedBatchedOnnx({
      tokenizer: fakeTokenizer(),
      model,
      texts: Array.from({ length: total }, (_, i) => `t${i}`),
      role: 'document',
      hiddenSize: hidden
    })
    expect(out).toHaveLength(total)
    expect(Math.max(...batches)).toBeLessThanOrEqual(ONNX_EMBED_MAX_BATCH)
    expect(batches).toEqual([
      ONNX_EMBED_MAX_BATCH,
      ONNX_EMBED_MAX_BATCH,
      ONNX_EMBED_MAX_BATCH,
      5
    ])
  })

  it('never builds a zero-width sequence tensor for degenerate tokenization', async () => {
    const tokenizer = async (text: string | string[]) => {
      const list = Array.isArray(text) ? text : [text]
      return { input_ids: { data: new BigInt64Array(0), dims: [list.length, 0] } }
    }
    class FakeTensor {
      constructor(
        readonly type: string,
        readonly data: ArrayBufferView,
        readonly dims: number[]
      ) {}
    }
    let sawBatchDims: number[] | null = null
    const model = async (inputs: unknown) => {
      const t = inputs as { input_ids: { dims: number[] } }
      sawBatchDims = t.input_ids.dims
      const b = t.input_ids.dims[0]!
      return { last_hidden_state: { data: new Float32Array(b * 2).fill(1), dims: [b, 1, 2] } }
    }
    const out = await embedBatchedOnnx({
      tokenizer,
      model,
      texts: ['a', 'b'],
      role: 'query',
      hiddenSize: 2,
      Tensor: FakeTensor as unknown as NonNullable<
        Parameters<typeof embedBatchedOnnx>[0]['Tensor']
      >
    })
    expect(out).toHaveLength(2)
    expect(sawBatchDims).not.toBeNull()
    expect(sawBatchDims![1]).toBeGreaterThan(0)
  })
})
