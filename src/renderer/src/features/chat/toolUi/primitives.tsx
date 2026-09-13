import { useEffect, useRef, useState } from 'react'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { Icon } from '@renderer/lib/icons'
import { copyText } from '@renderer/lib/markdown/copyText'
import { TOOL_BODY_INNER, TOOL_BODY_PAD } from '@renderer/lib/utils/layout'
import { cn } from '@renderer/lib/ui'
import { joinWorkspaceRel } from '@shared/utils/displayPath'
import { useRunSession } from '../RunSessionContext'

export function TruncatedBanner({
  loading = false,
  failed = false
}: {
  loading?: boolean
  failed?: boolean
}) {
  return (
    <p className="m-0 px-3 py-1 text-2xs text-tertiary">
      {loading
        ? 'Loading full output…'
        : failed
          ? 'Could not load full output.'
          : 'Showing truncated preview…'}
    </p>
  )
}

export function CodeBlock({
  lines,
  startLine = 1,
  className
}: {
  lines: string[]
  startLine?: number
  className?: string
}) {
  if (!lines.length) return null

  return (
    <div
      className={cn(
        'overflow-x-auto font-mono text-caption leading-mono',
        TOOL_BODY_PAD,
        className
      )}
    >
      {lines.map((text, index) => (
        <div key={index} className="flex min-w-0 gap-2">
          <span className="w-8 shrink-0 select-none text-right tabular-nums text-tertiary">
            {startLine + index}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap text-fg/80 [overflow-wrap:anywhere]">
            {text || '\u00a0'}
          </span>
        </div>
      ))}
    </div>
  )
}

export function PathList({ paths }: { paths: string[] }) {
  const { onOpenWorkspaceFile } = useRunSession()
  if (!paths.length) {
    return <p className={cn(TOOL_BODY_PAD, 'm-0 text-caption text-tertiary')}>No matches</p>
  }

  // No inner max-height scrollport — parent tool/group viewport owns scrolling.
  return (
    <ul className={cn(TOOL_BODY_INNER, 'm-0 list-none overflow-visible p-0 pr-5')}>
      {paths.map((path) => (
        <li key={path} className="group flex min-w-0 items-center gap-1.5 py-0.5">
          <FileTypeIcon path={path} size={14} />
          {onOpenWorkspaceFile ? (
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left font-mono text-caption text-fg/80 underline-offset-2 hover:underline"
              title={path}
              onClick={() => onOpenWorkspaceFile(path)}
            >
              {path}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg/80" title={path}>
              {path}
            </span>
          )}
          <CopyButton
            text={path}
            className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          />
        </li>
      ))}
    </ul>
  )
}

export function DirListing({
  entries,
  basePath
}: {
  entries: { kind: 'dir' | 'file'; name: string; size: string }[]
  basePath?: string
}) {
  const { onOpenWorkspaceFile } = useRunSession()
  if (!entries.length) {
    return <p className={cn(TOOL_BODY_PAD, 'm-0 text-caption text-tertiary')}>Empty directory</p>
  }

  const openFile = onOpenWorkspaceFile
  const canOpen = openFile != null && basePath != null

  // Flow with parent scroll; pr-5 clears disclosure chevrons / side chrome so
  // size labels stay on the filename row instead of stacking in the gutter.
  return (
    <div className={cn(TOOL_BODY_INNER, 'overflow-visible pr-5')} data-dir-listing="">
      {entries.map((entry) => {
        const rel = basePath != null ? joinWorkspaceRel(basePath, entry.name) : entry.name
        const label = `${entry.name}${entry.kind === 'dir' ? '/' : ''}`
        return (
          <div
            key={entry.name}
            className="flex min-w-0 items-center gap-2 py-0.5 font-mono text-caption"
          >
            <FileTypeIcon
              path={entry.name}
              kind={entry.kind === 'dir' ? 'folder' : 'file'}
              size={14}
            />
            {canOpen && openFile ? (
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-fg/80 underline-offset-2 hover:underline"
                title={rel}
                onClick={() => openFile(rel)}
              >
                {label}
              </button>
            ) : (
              <span className="min-w-0 flex-1 truncate text-fg/80" title={entry.name}>
                {label}
              </span>
            )}
            {entry.size ? (
              <span
                className="shrink-0 tabular-nums text-tertiary"
                title={`Size ${entry.size}`}
              >
                {entry.size}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export function MatchList({
  groups
}: {
  groups: { file: string; matches: { line: number; text: string; isMatch: boolean }[] }[]
}) {
  const { onOpenWorkspaceFile } = useRunSession()
  if (!groups.length) {
    return <p className={cn(TOOL_BODY_PAD, 'm-0 text-caption text-tertiary')}>No matches</p>
  }

  return (
    <div className={cn(TOOL_BODY_INNER, 'flex flex-col gap-2 overflow-visible pr-5')}>
      {groups.map((group) => (
        <div key={group.file}>
          <div
            className="flex min-w-0 items-center gap-1.5 truncate font-mono text-2xs font-medium text-tertiary"
            title={group.file}
          >
            <FileTypeIcon path={group.file} size={12} />
            {onOpenWorkspaceFile ? (
              <button
                type="button"
                className="min-w-0 truncate text-left underline-offset-2 hover:underline"
                onClick={() => onOpenWorkspaceFile(group.file)}
              >
                {group.file}
              </button>
            ) : (
              <span className="min-w-0 truncate">{group.file}</span>
            )}
          </div>
          {group.matches.map((match) => (
            <div
              key={`${group.file}:${match.line}`}
              className="grid grid-cols-[auto_1fr] gap-x-2 py-px font-mono text-caption"
            >
              {onOpenWorkspaceFile ? (
                <button
                  type="button"
                  className="tabular-nums text-left text-tertiary underline-offset-2 hover:underline"
                  onClick={() => onOpenWorkspaceFile(group.file, { line: match.line })}
                >
                  {match.line}
                </button>
              ) : (
                <span className="tabular-nums text-tertiary">{match.line}</span>
              )}
              <span
                className={
                  match.isMatch
                    ? 'whitespace-pre-wrap text-fg [overflow-wrap:anywhere]'
                    : 'whitespace-pre-wrap text-fg/60 [overflow-wrap:anywhere]'
                }
              >
                {match.text}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-border bg-surface-2/60 px-1.5 py-px font-mono text-2xs text-tertiary">
      {children}
    </span>
  )
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const copy = async (): Promise<void> => {
    const ok = await copyText(text)
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    setCopied(ok)
    setCopyError(!ok)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setCopied(false)
      setCopyError(false)
    }, 1500)
  }

  const label = copied ? 'Copied' : copyError ? 'Copy failed' : 'Copy'

  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-2xs text-tertiary vy-transition hover:text-fg',
        className
      )}
      onClick={() => void copy()}
      aria-label={label}
      title={label}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      {label}
    </button>
  )
}
