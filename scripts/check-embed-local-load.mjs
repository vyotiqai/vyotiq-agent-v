/**
 * Functional verification for the embed worker's REAL load path (evidence, not CI).
 *
 * Run: node scripts/check-embed-local-load.mjs
 * 1. Downloads the q8 MiniLM artifacts with the production layout
 *    (onnx/model_quantized.onnx under the model dir) into a temp cache dir.
 * 2. Loads the pipeline exactly like embedUtility.loadSession does:
 *    env.allowRemoteModels=false, env.cacheDir=<dir>, local dir as model id,
 *    local_files_only=true, dtype 'q8'.
 * 3. Embeds two texts, prints dims + cosine.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pipeline, env } from '@huggingface/transformers'

const REPO = 'Xenova/all-MiniLM-L6-v2'
const FILES = [
  'config.json',
  'onnx/model_quantized.onnx',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json'
]

const dir = join(tmpdir(), `vy-embed-load-check-${process.pid}`)
mkdirSync(dir, { recursive: true })

for (const rel of FILES) {
  const target = join(dir, rel)
  if (existsSync(target)) continue
  const url = `https://huggingface.co/${REPO}/resolve/main/${rel}`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    console.error(`DOWNLOAD-FAILED ${rel} ${res.status}`)
    process.exit(1)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(dirname(target), { recursive: true })
  const part = `${target}.part`
  writeFileSync(part, buf)
  renameSync(part, target)
  console.log(`downloaded ${rel} (${buf.length} bytes)`)
}

env.allowLocalModels = true
env.allowRemoteModels = false
env.useBrowserCache = false
env.cacheDir = dir

const asr = await pipeline('feature-extraction', dir, {
  local_files_only: true,
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
    `dims=${out.dims.join('x')} head4=[${Array.from(data.slice(0, 4)).map((v) => v.toFixed(4)).join(', ')}]`
  )
}

const [a, b] = vecs
let dot = 0
for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
console.log(`LOCAL-LOAD-OK cosine=${dot.toFixed(4)} dim=${a.length}`)