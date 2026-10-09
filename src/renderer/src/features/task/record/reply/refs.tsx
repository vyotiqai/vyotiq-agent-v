import { createContext, useContext, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'
import { isKnownFileType } from '@renderer/features/inspector/fileFacts'
import { isLinkableWorkspacePath } from '@shared/utils/linkableWorkspacePath'
import { useRunSession } from '@renderer/features/chat/RunSessionContext'

/*
  Paths in an answer are the thing a coding reply is most often about, so a
  workspace path is a chip you can open: the folder quiet, the file name
  plain, the line after it. Where nothing can open files, a path stays code;
  a chip that opens nothing would be a lie.
*/

export type MdCtx = {
  streaming: boolean
  /** Opens a workspace file, at a line when the answer names one. Absent: paths stay text. */
  open?: (path: string, line?: number) => void
  /** The markdown of the block being rendered — what a table's Copy as Markdown hands over. */
  source?: string
  /** Prefix for heading ids, so two replies on one page never share one. */
  scope?: string
}
export const MdContext = createContext<MdCtx>({ streaming: false })
export const useMd = (): MdCtx => useContext(MdContext)

/** Inside a link: a path there is the link's text, not a second control nested in it. */
export const InLink = createContext(false)

/** `src/a.ts`, `./a.ts`, `a.ts:42`, `a.ts:42:7`, `src/a.ts:40-52`, `src/a.ts#L42`. */
const PATH = /^((?:[\w@.~-]+\/)*[\w@.~-]*\.[a-z][\w]{0,9}|(?:[\w@.~-]+\/)+[\w@.~-]+)(?::(\d+)(?:-\d+|:\d+)?|#L(\d+)(?:-L?\d+)?)?$/i

/**
 * A workspace path and its first line, or null — the app's own rule decides
 * what is a path. A bare name with no folder must also be a known file type:
 * `req.apiKey` and `os.path` are code, and a chip for them would open nothing.
 */
export function parsePath(text: string): { path: string; line?: number } | null {
  const m = PATH.exec(text.trim().replace(/^\.\//, ''))
  if (!m || /^\d|^\.+$/.test(m[1]!) || !isLinkableWorkspacePath(m[1]!)) return null
  if (!m[1]!.includes('/') && !isKnownFileType(m[1]!)) return null
  const line = m[2] ?? m[3]
  return { path: m[1]!, line: line ? Number(line) : undefined }
}

const CODE = cn('vy-reply-code border-b', BORDER_DIVIDER)

export function FileRef({ path, line, bare = false }: { path: string; line?: number; bare?: boolean }) {
  const { open } = useMd()
  // Ctrl/Cmd+click: the same file, at the same line, in the person's own editor.
  const { workspacePath } = useRunSession()
  const slash = path.lastIndexOf('/')
  const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
  const name = path.slice(slash + 1)
  const body = (
    <>
      {dir ? <span className="text-tertiary">{dir}</span> : null}
      <span className="vy-reply-file-name">{name}</span>
      {line && !bare ? <span className="text-tertiary">:{line}</span> : null}
    </>
  )
  if (!open) {
    return bare ? (
      <span className="flex min-w-0 items-center gap-1.5 font-mono">
        <Icon name="file" size={12} className="shrink-0 text-tertiary" />
        <span className="truncate">{body}</span>
      </span>
    ) : (
      <code className={CODE}>
        {path}
        {line ? `:${line}` : ''}
      </code>
    )
  }
  return (
    <button
      type="button"
      onClick={() => open(path, line)}
      title={`Open ${path}${line ? ` at line ${line}` : ''}`}
      data-code-chip
      className={
        bare
          ? 'flex min-w-0 items-center gap-1.5 rounded-sm font-mono underline-offset-[3px] hover:underline focus-visible:vy-focus-ring'
          : 'vy-reply-file focus-visible:vy-focus-ring'
      }
    >
      <Icon name="file" size={12} className="shrink-0 text-tertiary" />
      <span className={bare ? 'truncate' : ''}>{body}</span>
    </button>
  )
}

/** `code` in prose: a chip when it is a whole workspace path and something can open it, otherwise mono text. */
export function InlineCode({ children }: { children?: ReactNode }) {
  const ref = parsePath(String(children ?? ''))
  const { open } = useMd()
  const inLink = useContext(InLink)
  if (ref && open && !inLink) return <FileRef path={ref.path} line={ref.line} />
  return <code className={CODE}>{children}</code>
}
