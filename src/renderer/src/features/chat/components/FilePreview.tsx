import { useState } from 'react'
import { MarkdownContent, cn } from '@renderer/lib/ui'
import {
  filePreviewKind,
  previewSourceUrl,
  type FilePreviewKind
} from './filePreviewKind'

export function FilePreview({
  path,
  content,
  binary
}: {
  path: string
  content: string
  binary: boolean
}) {
  const kind = filePreviewKind(path)
  // Hooks must sit above every early return (component returns per kind).
  const [allowScripts, setAllowScripts] = useState(false)

  if (!kind) return null

  if (kind === 'markdown') {
    return (
      <div
        className="min-h-0 flex-1 overflow-auto px-4 py-3"
        data-file-preview="markdown"
      >
        <MarkdownContent content={content} readOnlyTasks className="text-sm" />
      </div>
    )
  }

  if (kind === 'html') {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-file-preview="html">
        <div className="flex shrink-0 items-center gap-1 border-b border-border/40 bg-bg px-2 py-1 text-caption text-muted">
          <button
            type="button"
            onClick={() => setAllowScripts((value) => !value)}
            aria-pressed={allowScripts}
            className={cn(
              'rounded px-1.5 py-0.5 text-2xs transition-colors',
              allowScripts
                ? 'text-fg'
                : 'text-muted hover:bg-surface hover:text-fg'
            )}
          >
            {allowScripts ? 'Scripts on' : 'Enable scripts'}
          </button>
        </div>
        <iframe
          // Remount on toggle: Chromium does not reliably apply a dynamically
          // changed sandbox attribute to an already-loaded frame.
          key={allowScripts ? 'html-scripts-on' : 'html-scripts-off'}
          title={`Preview ${path}`}
          sandbox={allowScripts ? 'allow-scripts' : ''}
          srcDoc={content}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      </div>
    )
  }

  const src = previewSourceUrl(kind, path, content, binary)
  if (!src) return null
  return (
    <div
      className="grid min-h-0 flex-1 place-items-center overflow-auto bg-bg p-4"
      data-file-preview={kind}
    >
      <img src={src} alt={path} className="max-h-full max-w-full object-contain" />
    </div>
  )
}

export type { FilePreviewKind }
