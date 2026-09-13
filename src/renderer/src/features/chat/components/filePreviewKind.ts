export type FilePreviewKind = 'image' | 'svg' | 'markdown' | 'html'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif'])
const MARKDOWN_EXTS = new Set(['.md', '.mdc', '.markdown'])
const HTML_EXTS = new Set(['.html', '.htm'])

function extOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const base = slash >= 0 ? path.slice(slash + 1) : path
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}

export function filePreviewKind(path: string): FilePreviewKind | null {
  const ext = extOf(path)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ext === '.svg') return 'svg'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (HTML_EXTS.has(ext)) return 'html'
  return null
}

export function imageMimeForPath(path: string): string {
  const ext = extOf(path)
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.ico') return 'image/x-icon'
  if (ext === '.avif') return 'image/avif'
  if (ext === '.svg') return 'image/svg+xml'
  return 'image/png'
}

export function previewSourceUrl(
  kind: FilePreviewKind,
  path: string,
  content: string,
  binary: boolean
): string | null {
  if (kind === 'markdown' || kind === 'html') return null
  if (kind === 'svg') {
    if (binary) return `data:image/svg+xml;base64,${content}`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`
  }
  if (!binary) return null
  return `data:${imageMimeForPath(path)};base64,${content}`
}

/** Images default to preview; source files start in the editor. */
export function defaultPreviewOpen(kind: FilePreviewKind | null): boolean {
  return kind === 'image'
}
