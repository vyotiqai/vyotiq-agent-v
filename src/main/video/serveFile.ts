import { createReadStream, statSync } from 'fs'
import { extname } from 'path'
import { Readable } from 'stream'

const MEDIA_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp'
}

export type MediaKind = 'video' | 'audio' | 'image'

/** Mime type for a media file by extension, or null when it is not one we serve. */
export function mediaMimeForPath(path: string): string | null {
  return MEDIA_MIME[extname(path).toLowerCase()] ?? null
}

export function mediaKindForPath(path: string): MediaKind | null {
  const mime = mediaMimeForPath(path)
  if (!mime) return null
  return mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image'
}

type ByteRange = { start: number; end: number }

/** One `bytes=` range against a file of `size` bytes; null when absent or unsatisfiable. */
export function parseByteRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null
  let start: number
  let end: number
  if (!rawStart) {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/**
 * Answer a GET for a file on disk, honouring a Range header — a <video> seeks
 * by asking for byte ranges, and mediabunny's UrlSource reads files the same way.
 */
export function serveFileResponse(request: Request, absPath: string, mime: string): Response {
  let size: number
  try {
    const st = statSync(absPath)
    if (!st.isFile()) return new Response('Not a file', { status: 404 })
    size = st.size
  } catch {
    return new Response('Not found', { status: 404 })
  }
  const base = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store'
  }
  const range = parseByteRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${size}` } })
  }
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { ...base, 'content-length': String(size) } })
  }
  if (!range) {
    const body = size === 0 ? null : (Readable.toWeb(createReadStream(absPath)) as ReadableStream<Uint8Array>)
    return new Response(body, { status: 200, headers: { ...base, 'content-length': String(size) } })
  }
  const stream = createReadStream(absPath, { start: range.start, end: range.end })
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: 206,
    headers: {
      ...base,
      'content-length': String(range.end - range.start + 1),
      'content-range': `bytes ${range.start}-${range.end}/${size}`
    }
  })
}
