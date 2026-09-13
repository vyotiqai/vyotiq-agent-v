/**
 * Image token accounting. A flat per-image constant is wrong by an order of
 * magnitude at the extremes (a 64x64 icon vs a 4K screenshot), which matters
 * once the estimate drives compaction. Dimensions come from the image header
 * inside the data URL, so no decoding library is needed.
 */

/** Enough bytes to reach the SOF marker in a typical JPEG, even with heavy EXIF. */
const HEADER_BYTES = 32 * 1024

/** A ~1024x768 screenshot, the common case when dimensions are unavailable. */
export const DEFAULT_IMAGE_TOKENS = 765

export type ImageDimensions = { width: number; height: number }

function dataUrlHeaderBytes(url: string): Buffer | null {
  if (!url.startsWith('data:')) return null
  const comma = url.indexOf(',')
  if (comma < 0) return null
  if (!url.slice(5, comma).includes('base64')) return null
  // 4 base64 characters decode to 3 bytes; over-read slightly and let Buffer trim.
  const b64 = url.slice(comma + 1, comma + 1 + Math.ceil(HEADER_BYTES / 3) * 4)
  try {
    const buf = Buffer.from(b64, 'base64')
    return buf.length ? buf : null
  } catch {
    return null
  }
}

function pngDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (signature.some((byte, i) => buf[i] !== byte)) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function gifDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null
  const magic = buf.toString('ascii', 0, 6)
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

function jpegDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let pos = 2
  while (pos + 9 < buf.length) {
    if (buf[pos] !== 0xff) {
      pos++
      continue
    }
    const marker = buf[pos + 1]!
    // SOF0-SOF15 carry the frame size; C4/C8/CC are Huffman/arithmetic tables.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) }
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      pos += 2
      continue
    }
    const segmentLength = buf.readUInt16BE(pos + 2)
    if (segmentLength < 2) return null
    pos += 2 + segmentLength
  }
  return null
}

function webpDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16))
    const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16))
    return { width, height }
  }
  if (chunk === 'VP8 ' && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  return null
}

/** Read intrinsic pixel dimensions from a base64 data URL, or null if unreadable. */
export function imageDimensionsFromDataUrl(url: string): ImageDimensions | null {
  const buf = dataUrlHeaderBytes(url)
  if (!buf) return null
  const dims =
    pngDimensions(buf) ?? jpegDimensions(buf) ?? gifDimensions(buf) ?? webpDimensions(buf)
  if (!dims || dims.width <= 0 || dims.height <= 0) return null
  return dims
}

/**
 * Tile-based cost, following the OpenAI vision formula: fit inside 2048x2048,
 * shrink the shortest side to 768, then charge per 512x512 tile. Anthropic and
 * Gemini price differently but land in the same order of magnitude, and the
 * estimate is superseded by real provider usage after the first response.
 */
export function imageTokensForDimensions(width: number, height: number): number {
  let w = width
  let h = height
  const longest = Math.max(w, h)
  if (longest > 2048) {
    const scale = 2048 / longest
    w = Math.round(w * scale)
    h = Math.round(h * scale)
  }
  const shortest = Math.min(w, h)
  if (shortest > 768) {
    const scale = 768 / shortest
    w = Math.round(w * scale)
    h = Math.round(h * scale)
  }
  const tiles = Math.max(1, Math.ceil(w / 512) * Math.ceil(h / 512))
  return 85 + 170 * tiles
}

export function estimateImageTokens(url: string): number {
  const dims = imageDimensionsFromDataUrl(url)
  if (!dims) return DEFAULT_IMAGE_TOKENS
  return imageTokensForDimensions(dims.width, dims.height)
}
