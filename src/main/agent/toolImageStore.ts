import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ToolImageRef } from '../../shared/ipc'
import { imageDimensionsFromBytes } from './context/imageTokens'
import { MAX_TOOL_IMAGE_BYTES } from './context/toolImages'

/** Longest edge every vision provider accepts (Anthropic's hard limit). */
export const MAX_TOOL_IMAGE_EDGE = 8000

type ImageFormat = { ext: 'png' | 'jpg' | 'gif' | 'webp'; mime: string }

/** Format from magic bytes: a declared mime type is a claim, the header is the file. */
export function sniffImageFormat(bytes: Buffer): ImageFormat | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { ext: 'png', mime: 'image/png' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' }
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    return { ext: 'gif', mime: 'image/gif' }
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp' }
  }
  return null
}

let seq = 0

export type StoreToolImageResult =
  | { ok: true; image: ToolImageRef; mime: string; bytes: number }
  | { ok: false; reason: string }

/**
 * Store an image a tool returned under `<runDir>/images/`, so the model can be
 * shown it and the transcript can render it. Refuses what no provider would
 * accept rather than letting one oversized image fail the next request.
 */
export function storeToolImage(
  runDir: string,
  bytes: Buffer,
  opts: { source: 'mcp' | 'read' | 'snip'; label?: string }
): StoreToolImageResult {
  const format = sniffImageFormat(bytes)
  if (!format) return { ok: false, reason: 'not a PNG, JPEG, GIF or WebP image' }
  if (bytes.length > MAX_TOOL_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `${Math.round(bytes.length / 1024)} KB exceeds the ${MAX_TOOL_IMAGE_BYTES / 1024 / 1024} MB image limit`
    }
  }
  const dims = imageDimensionsFromBytes(bytes)
  if (dims && Math.max(dims.width, dims.height) > MAX_TOOL_IMAGE_EDGE) {
    return {
      ok: false,
      reason: `${dims.width}x${dims.height} exceeds the ${MAX_TOOL_IMAGE_EDGE}px edge limit`
    }
  }
  seq += 1
  const artifact = `images/${opts.source}-${Date.now()}-${seq}.${format.ext}`
  const dir = join(runDir, 'images')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(runDir, artifact), bytes)
  return {
    ok: true,
    mime: format.mime,
    bytes: bytes.length,
    image: {
      artifact,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
      ...(opts.label ? { label: opts.label.slice(0, 200) } : {})
    }
  }
}
