/** Little-endian 16-bit PCM helpers shared by the speech adapters. */

export function base64ToInt16(b64: string): Int16Array {
  const bytes = Buffer.from(b64, 'base64')
  return bytesToInt16(bytes.subarray(0, bytes.length - (bytes.length % 2)))
}

/** Copy (never alias) an even-length LE byte run into an Int16Array. */
export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

/**
 * Turns an HTTP body's arbitrary byte chunks into whole samples: a chunk can
 * end halfway through a sample, so the odd byte is carried to the next one.
 */
export class PcmAssembler {
  private carry: number | null = null

  push(chunk: Uint8Array): Int16Array {
    let bytes = chunk
    if (this.carry !== null) {
      const joined = new Uint8Array(chunk.length + 1)
      joined[0] = this.carry
      joined.set(chunk, 1)
      bytes = joined
      this.carry = null
    }
    if (bytes.length % 2 === 1) {
      this.carry = bytes[bytes.length - 1]!
      bytes = bytes.subarray(0, bytes.length - 1)
    }
    return bytesToInt16(bytes)
  }
}
