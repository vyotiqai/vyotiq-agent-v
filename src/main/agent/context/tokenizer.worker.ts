/**
 * Node worker_threads entry: BPE encode only (no Electron / agent imports).
 * Built as `out/main/tokenizer.worker.js` via electron-vite rollup input.
 * `bpeCount` imports gpt-tokenizer and nothing else.
 */
import { parentPort } from 'node:worker_threads'
import { countBpeTokens, type EncodingName } from './bpeCount'

type CountRequest = {
  id: number
  items: Array<{ text: string; encoding: EncodingName }>
}

const port = parentPort
if (!port) {
  throw new Error('tokenizer.worker must run as a worker_threads Worker')
}

port.on('message', (msg: CountRequest) => {
  try {
    const counts = msg.items.map((item) => countBpeTokens(item.text, item.encoding))
    port.postMessage({ id: msg.id, counts })
  } catch (err) {
    port.postMessage({
      id: msg.id,
      error: err instanceof Error ? err.message : String(err)
    })
  }
})
