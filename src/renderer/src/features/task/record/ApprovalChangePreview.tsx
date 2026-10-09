import type { ApprovalChangeLine, ApprovalChangePreview as Preview } from '@shared/ipc'
import { cn } from '@renderer/lib/ui'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'

const ROW: Record<ApprovalChangeLine['kind'], string> = {
  ' ': '',
  '+': 'diff-row-add',
  '-': 'diff-row-del',
  '@': 'bg-surface text-tertiary'
}
const SIGN: Record<ApprovalChangeLine['kind'], string> = { ' ': '', '+': '+', '-': '−', '@': '' }
const SIGN_TONE: Record<ApprovalChangeLine['kind'], string> = {
  ' ': '',
  '+': 'text-success',
  '-': 'text-danger',
  '@': ''
}

function note(preview: Preview): string | null {
  if (preview.action === 'create') return 'new file'
  if (preview.action === 'rewrite') return 'replaces the whole file'
  if (preview.everyMatch) return 'every match'
  return null
}

/**
 * The change an edit approval asks for, as −/+ rows: the card used to show
 * only the path and a line of raw JSON. A bordered block, like every diff in
 * the record; the sign gutter carries add and remove, the tint only repeats
 * it. A new file is all additions, so it drops the tint and keeps the signs.
 */
export function ApprovalChangePreview({ preview }: { preview: Preview }) {
  const extra = note(preview)
  const tinted = preview.action !== 'create'
  return (
    <div className="overflow-hidden rounded-md border border-border bg-sunken" data-approval-change="">
      <div className={cn('flex min-w-0 items-center gap-2 border-b px-3 py-1.5 text-xs', BORDER_DIVIDER)}>
        <span className="min-w-0 flex-1 truncate font-mono text-fg-strong" title={preview.path}>
          {preview.path}
        </span>
        {extra ? <span className="shrink-0 text-tertiary">{extra}</span> : null}
        <span className="shrink-0 font-mono tnum">
          {preview.add > 0 ? <span className="text-success">+{preview.add}</span> : null}
          {preview.add > 0 && preview.del > 0 ? ' ' : null}
          {preview.del > 0 ? <span className="text-danger">−{preview.del}</span> : null}
        </span>
      </div>
      <div className="scroll-thin max-h-72 overflow-auto py-1 font-mono text-xs leading-[18px]">
        {preview.lines.length === 0 ? (
          <div className="px-3 text-tertiary">No lines change.</div>
        ) : (
          preview.lines.map((line, index) => (
            <div key={index} className={cn('flex min-w-max', tinted ? ROW[line.kind] : line.kind === '@' ? ROW['@'] : '')}>
              <span className={cn('w-6 shrink-0 select-none text-center', SIGN_TONE[line.kind])} aria-hidden={!SIGN[line.kind]}>
                {SIGN[line.kind]}
              </span>
              <span className={cn('whitespace-pre pr-3', line.kind === '@' ? 'text-tertiary' : 'text-fg')}>
                <span className="sr-only">{line.kind === '+' ? 'added: ' : line.kind === '-' ? 'removed: ' : ''}</span>
                {line.text || ' '}
              </span>
            </div>
          ))
        )}
      </div>
      {preview.hiddenLines > 0 ? (
        <div className={cn('border-t px-3 py-1 text-caption text-tertiary', BORDER_DIVIDER)}>
          {preview.hiddenLines.toLocaleString('en-US')} more {preview.hiddenLines === 1 ? 'line' : 'lines'} not shown
        </div>
      ) : null}
    </div>
  )
}
