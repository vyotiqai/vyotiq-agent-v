/**
 * Real-model smoke check for the embedding leg (evidence, not CI).
 *
 * Run: node scripts/smoke-embed-model.mjs
 * Loads the q8 MiniLM artifacts the same way the embedUtility entry does
 * (feature-extraction, dtype q8, mean pooling + normalize) and prints the
 * embedding dimension plus a cosine sanity check.
 */
import { pipeline } from '@huggingface/transformers'

const asr = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
  dtype: 'q8'
})

const texts = [
  'Fix a failing vitest suite in tests/main/unit',
  'The invoice total does not match the sum of its line items'
]

const vecs = []
for (const text of texts) {
  const out = await asr(text, { pooling: 'mean', normalize: true })
  const data = out.data
  vecs.push(new Float32Array(data))
  console.log(
    `dims=${out.dims.join('x')} head8=[${Array.from(data.slice(0, 8)).map((v) => v.toFixed(4)).join(', ')}]`
  )
}

const [a, b] = vecs
let dot = 0
for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
console.log(`cosine=${dot.toFixed(4)} dim=${a.length}`)