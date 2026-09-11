/**
 * Shared ONNX embed path: one forward per batch + DenseOn CLS pooling.
 * Used by the utility child and in-process loader.
 */

export const ONNX_EMBED_MAX_LENGTH = 512
/**
 * One forward covers at most this many texts. Larger requests are chunked so a
 * single pathological batch can never pin the utility/ORT in one inference.
 */
export const ONNX_EMBED_MAX_BATCH = 32

export function l2NormalizeInPlace(vec: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < vec.length; i++) vec[i]! /= norm
  return vec
}

/**
 * CLS = first token of each row in `last_hidden_state` [batch, seq, hidden], then L2.
 * Also accepts [batch, hidden] (already pooled) and [seq, hidden] (single sequence).
 */
export function clsPoolLastHidden(
  data: ArrayLike<number>,
  dims: number[],
  fallbackHidden: number,
  expectedBatch = 1
): Float32Array[] {
  if (dims.length === 3) {
    const batch = dims[0]!
    const seq = dims[1]!
    const hidden = dims[2]!
    const out: Float32Array[] = []
    for (let b = 0; b < batch; b++) {
      const offset = b * seq * hidden
      const vec = new Float32Array(hidden)
      for (let i = 0; i < hidden; i++) vec[i] = Number(data[offset + i] ?? 0)
      out.push(l2NormalizeInPlace(vec))
    }
    return out
  }

  if (dims.length === 2) {
    const d0 = dims[0]!
    const d1 = dims[1]!
    const pooledBatch = d0 === expectedBatch && (expectedBatch > 1 || d1 === fallbackHidden)
    if (pooledBatch) {
      const out: Float32Array[] = []
      for (let b = 0; b < d0; b++) {
        const offset = b * d1
        const vec = new Float32Array(d1)
        for (let i = 0; i < d1; i++) vec[i] = Number(data[offset + i] ?? 0)
        out.push(l2NormalizeInPlace(vec))
      }
      return out
    }
    const vec = new Float32Array(d1)
    for (let i = 0; i < d1; i++) vec[i] = Number(data[i] ?? 0)
    return [l2NormalizeInPlace(vec)]
  }

  const hidden = dims.length > 0 ? dims[dims.length - 1]! : fallbackHidden
  const vec = new Float32Array(hidden)
  for (let i = 0; i < hidden; i++) vec[i] = Number(data[i] ?? 0)
  return [l2NormalizeInPlace(vec)]
}

type TensorLike = {
  data: ArrayLike<number | bigint>
  dims: number[]
}

type TokenizedBatch = {
  input_ids: TensorLike
  attention_mask?: TensorLike
  token_type_ids?: TensorLike
}

export type OnnxTokenizer = {
  (
    text: string | string[],
    opts?: Record<string, unknown>
  ): Promise<TokenizedBatch> | TokenizedBatch
  pad_token_id?: number | bigint | null
}

export type OnnxTensorCtor = new (
  type: string,
  data: ArrayBufferView,
  dims: number[]
) => unknown

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

function toBigInt64(data: ArrayLike<number | bigint>): BigInt64Array {
  if (data instanceof BigInt64Array) return data
  const out = new BigInt64Array(data.length)
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    out[i] = typeof v === 'bigint' ? v : BigInt(v ?? 0)
  }
  return out
}

function batchDim(t: TensorLike | undefined): number | undefined {
  return t?.dims?.[0]
}

async function tokenizePaddedBatch(
  tokenizer: OnnxTokenizer,
  texts: string[],
  Tensor: OnnxTensorCtor | undefined
): Promise<unknown> {
  try {
    const batched = await tokenizer(texts, {
      padding: true,
      truncation: true,
      max_length: ONNX_EMBED_MAX_LENGTH
    })
    const seqLen = batched?.input_ids?.dims?.[1]
    if (batchDim(batched?.input_ids) === texts.length && (seqLen == null || seqLen > 0)) {
      return batched
    }
  } catch {
    /* tokenize per item and stack */
  }

  if (!Tensor) {
    throw new Error('ONNX tokenizer rejected a string[] batch and Tensor ctor is unavailable')
  }

  const encoded: TokenizedBatch[] = []
  let maxLen = 0
  for (const text of texts) {
    const one = await tokenizer(text, {
      padding: false,
      truncation: true,
      max_length: ONNX_EMBED_MAX_LENGTH
    })
    encoded.push(one)
    maxLen = Math.max(maxLen, one.input_ids.data.length)
  }
  // An empty/degenerate tokenization would build tensors with a zero sequence
  // dimension; some ORT builds spin on [batch, 0] inputs. Keep at least one.
  maxLen = Math.max(1, maxLen)

  const batch = encoded.length
  const idData = new BigInt64Array(batch * maxLen)
  const maskData = new BigInt64Array(batch * maxLen)
  const padId = BigInt(tokenizer.pad_token_id ?? 0)
  let hasTypeIds = false
  for (const one of encoded) {
    if (one.token_type_ids) hasTypeIds = true
  }
  const typeData = hasTypeIds ? new BigInt64Array(batch * maxLen) : null

  for (let i = 0; i < batch; i++) {
    const ids = toBigInt64(encoded[i]!.input_ids.data)
    const mask = encoded[i]!.attention_mask
      ? toBigInt64(encoded[i]!.attention_mask!.data)
      : null
    const types = encoded[i]!.token_type_ids
      ? toBigInt64(encoded[i]!.token_type_ids!.data)
      : null
    const row = i * maxLen
    const len = ids.length
    for (let j = 0; j < maxLen; j++) {
      if (j < len) {
        idData[row + j] = ids[j]!
        maskData[row + j] = mask ? mask[j]! : 1n
        if (typeData) typeData[row + j] = types ? types[j]! : 0n
      } else {
        idData[row + j] = padId
        maskData[row + j] = 0n
      }
    }
  }

  const out: Record<string, unknown> = {
    input_ids: new Tensor('int64', idData, [batch, maxLen]),
    attention_mask: new Tensor('int64', maskData, [batch, maxLen])
  }
  if (typeData) {
    out.token_type_ids = new Tensor('int64', typeData, [batch, maxLen])
  }
  return out
}

function hiddenFromOutputs(outputs: unknown): { data: ArrayLike<number>; dims: number[] } {
  const rec = outputs as {
    last_hidden_state?: { data: ArrayLike<number>; dims: number[] }
    logits?: { data: ArrayLike<number>; dims: number[] }
  }
  const hidden = rec.last_hidden_state ?? rec.logits
  if (!hidden?.data || !hidden.dims) {
    throw new Error('ONNX model output missing last_hidden_state')
  }
  return hidden
}

/** Prefix query/document, tokenize the whole batch, one forward, CLS-pool each row. */
export async function embedBatchedOnnx(opts: {
  tokenizer: OnnxTokenizer
  model: (inputs: unknown) => Promise<unknown>
  texts: string[]
  role: 'query' | 'document'
  signal?: AbortSignal
  hiddenSize: number
  Tensor?: OnnxTensorCtor
}): Promise<Float32Array[]> {
  throwIfAborted(opts.signal)
  if (opts.texts.length === 0) return []
  if (opts.texts.length > ONNX_EMBED_MAX_BATCH) {
    const out: Float32Array[] = []
    for (let i = 0; i < opts.texts.length; i += ONNX_EMBED_MAX_BATCH) {
      out.push(
        ...(await embedBatchedOnnx({
          ...opts,
          texts: opts.texts.slice(i, i + ONNX_EMBED_MAX_BATCH)
        }))
      )
      throwIfAborted(opts.signal)
    }
    return out
  }
  const prefix = opts.role === 'query' ? 'query: ' : 'document: '
  const prefixed = opts.texts.map((raw) => `${prefix}${typeof raw === 'string' ? raw : ''}`)
  const inputs = await tokenizePaddedBatch(opts.tokenizer, prefixed, opts.Tensor)
  throwIfAborted(opts.signal)
  const outputs = await opts.model(inputs)
  const hidden = hiddenFromOutputs(outputs)
  const pooled = clsPoolLastHidden(hidden.data, hidden.dims, opts.hiddenSize, opts.texts.length)
  if (pooled.length !== opts.texts.length) {
    throw new Error(
      `ONNX CLS pool size mismatch: got ${pooled.length} vectors for ${opts.texts.length} texts`
    )
  }
  return pooled
}
