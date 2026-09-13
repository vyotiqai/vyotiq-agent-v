/**
 * Node worker_threads entry: BPE encode only (no Electron / agent imports).
 * Built as `out/main/tokenizer.worker.js` via electron-vite rollup input.
 */
import { parentPort } from 'node:worker_threads'
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base'
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base'

type EncodingName = 'o200k_base' | 'cl100k_base'

type CountRequest = {
  id: number
  items: Array<{ text: string; encoding: EncodingName }>
}

const HEURISTIC_CHARS_PER_TOKEN = 4

function countOne(text: string, encoding: EncodingName): number {
  try {
    return encoding === 'cl100k_base' ? encodeCl100k(text).length : encodeO200k(text).length
  } catch {
    return Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN)
  }
}

const port = parentPort
if (!port) {
  throw new Error('tokenizer.worker must run as a worker_threads Worker')
}

port.on('message', (msg: CountRequest) => {
  try {
    const counts = msg.items.map((item) => countOne(item.text, item.encoding))
    port.postMessage({ id: msg.id, counts })
  } catch (err) {
    port.postMessage({
      id: msg.id,
      error: err instanceof Error ? err.message : String(err)
    })
  }
})
