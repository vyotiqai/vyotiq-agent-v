import { useCallback } from 'react'
import { ReplyMarkdown } from '@renderer/features/task/record/reply/ReplyMarkdown'

/*
  The agent's words, rendered by the app's own reply renderer
  (features/task/record/reply) — imported, not copied, so the mockup and the
  record can never drift apart. What is mockup-only is which files open: the
  app opens any workspace path, the mockup only the files a thread knows.
*/

export function Markdown({
  text,
  streaming = false,
  onOpenFile,
  files,
  className
}: {
  text: string
  streaming?: boolean
  /** Opens a file the thread knows, at a line when the answer names one. */
  onOpenFile?: (path: string, line?: number) => void
  /** Files the thread read or changed: the paths that open. */
  files?: ReadonlySet<string>
  className?: string
}) {
  const open = useCallback(
    (path: string, options?: { line?: number }) => {
      const known = [...(files ?? [])]
      // A shorter path names a file only when exactly one known file ends with it.
      const tail = known.filter((f) => f.endsWith(`/${path}`))
      const full = known.includes(path) ? path : tail.length === 1 ? tail[0] : null
      if (full) onOpenFile?.(full, options?.line)
    },
    [files, onOpenFile]
  )
  return <ReplyMarkdown text={text} streaming={streaming} size="md" onOpenWorkspaceFile={onOpenFile ? open : undefined} className={className} />
}

/** Plain words of an answer, for one-line previews. */
export function plainMarkdown(md: string): string {
  return md
    .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/^>\s?(?:\[![A-Z]+\]\s*)?/gim, '')
    .replace(/^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '$1')
    .replace(/<\/?(?:kbd|details|summary)(?:\s[^>]*)?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(?<![\w*~])(\*{1,3}|_{1,3}|~~)(?=\S)([\s\S]*?\S)\1(?![\w*])/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}
