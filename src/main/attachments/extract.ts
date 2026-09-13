import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_CHARS,
  type ExtractAttachmentRequest,
  type ExtractAttachmentResult
} from '../../shared/ipc'
import { logger } from '../../shared/logger'

/** Extensions we are willing to read as source text regardless of the reported mime. */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'mdx',
  'markdown',
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'csv',
  'tsv',
  'log',
  'sql',
  'graphql',
  'gql',
  'html',
  'htm',
  'xml',
  'svg',
  'css',
  'scss',
  'less',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'dockerfile',
  'gitignore',
  'patch',
  'diff'
])

export function attachmentExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return base.toLowerCase()
  return base.slice(dot + 1).toLowerCase()
}

export function isPdfAttachment(name: string, mime: string): boolean {
  return mime === 'application/pdf' || attachmentExtension(name) === 'pdf'
}

export function isTextAttachment(name: string, mime: string): boolean {
  if (mime.startsWith('text/')) return true
  if (/^application\/(json|xml|x-yaml|yaml|javascript|typescript|sql|toml)/.test(mime)) return true
  return TEXT_EXTENSIONS.has(attachmentExtension(name))
}

/** Heuristic binary check: NUL bytes never appear in the text formats we accept. */
function looksBinary(bytes: Buffer): boolean {
  const probe = bytes.subarray(0, 8192)
  for (const byte of probe) if (byte === 0) return true
  return false
}

function clip(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
  if (normalized.length <= MAX_ATTACHMENT_CHARS) return { text: normalized, truncated: false }
  return { text: `${normalized.slice(0, MAX_ATTACHMENT_CHARS)}\n… (truncated)`, truncated: true }
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  // unpdf ships as ESM only, so it has to be pulled in at call time from CJS main.
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  const { text } = await extractText(pdf, { mergePages: true })
  return Array.isArray(text) ? text.join('\n\n') : text
}

/**
 * Turn an attached file into text the model can read.
 *
 * Extraction lives in main because the parsers are Node-only and because the
 * size caps must hold no matter which surface picked the file.
 */
export async function extractAttachment(
  request: ExtractAttachmentRequest
): Promise<ExtractAttachmentResult> {
  const bytes = Buffer.from(request.data, 'base64')
  if (bytes.byteLength === 0) throw new Error(`${request.name} is empty`)
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    const limit = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))
    throw new Error(`${request.name} is larger than ${limit}MB`)
  }

  const mime = request.mime || ''
  if (isPdfAttachment(request.name, mime)) {
    let raw: string
    try {
      raw = await extractPdfText(bytes)
    } catch (err) {
      logger.warn('attachment: pdf extraction failed', { name: request.name, err })
      throw new Error(`Could not read text from ${request.name}`)
    }
    const { text, truncated } = clip(raw)
    if (!text) throw new Error(`${request.name} has no extractable text (it may be a scan)`)
    return { name: request.name, mime: 'application/pdf', text, truncated }
  }

  if (!isTextAttachment(request.name, mime) || looksBinary(bytes)) {
    throw new Error(`${request.name} is not a text or PDF file`)
  }

  const { text, truncated } = clip(bytes.toString('utf8'))
  if (!text) throw new Error(`${request.name} is empty`)
  return { name: request.name, mime: mime || 'text/plain', text, truncated }
}
