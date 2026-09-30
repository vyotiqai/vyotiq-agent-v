import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/ui'
import type { DiffLine } from './data'

/*
  Diffs. Rows pair a tint with a +/− gutter sign, never hue alone. A new file
  is all additions, so it drops the wash and the old-number column: the tint
  would say the same thing on every row.
*/

const NUM = 'select-none text-right align-top text-tertiary tnum'

export function DiffTable({ lines, added = false, layout = 'unified', more = 0 }: { lines: DiffLine[]; added?: boolean; layout?: 'unified' | 'split'; more?: number }) {
  return (
    <div className="scroll-thin overflow-x-auto">
      {layout === 'split' && !added ? <Split lines={lines} /> : <Unified lines={lines} added={added} />}
      {more > 0 ? <div className="border-t border-border/60 px-4 py-1.5 font-mono text-caption text-tertiary">⋯ {more} more changed lines in this file</div> : null}
    </div>
  )
}

function Unified({ lines, added }: { lines: DiffLine[]; added: boolean }) {
  return (
    <table className="w-full border-collapse font-mono text-caption leading-[20px]">
      <tbody>
        {lines.map((l, i) =>
          l.t === '@' ? (
            <tr key={i} className="bg-surface text-tertiary">
              <td colSpan={added ? 3 : 4} className="px-4 py-0.5">
                {l.s}
              </td>
            </tr>
          ) : (
            <tr key={i} className={added ? '' : l.t === '+' ? 'diff-row-add' : l.t === '-' ? 'diff-row-del' : ''}>
              {added ? null : <td className={cn(NUM, 'w-9 pr-1')}>{l.a ?? ''}</td>}
              <td className={cn(NUM, 'w-9 pr-2')}>{l.b ?? ''}</td>
              <td className={cn('w-4 select-none align-top', l.t === '+' ? 'text-success' : l.t === '-' ? 'text-danger' : 'text-tertiary')}>{l.t === '+' ? '+' : l.t === '-' ? '−' : ''}</td>
              <td className="whitespace-pre pr-4 text-fg">
                <Code s={l.s} />
              </td>
            </tr>
          )
        )}
      </tbody>
    </table>
  )
}

type Pair = { hunk?: string; left?: DiffLine; right?: DiffLine }

/** Old on the left, new on the right; a run of removals pairs with the additions after it. */
function pairs(lines: DiffLine[]): Pair[] {
  const out: Pair[] = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (l.t === '@') {
      out.push({ hunk: l.s })
      i++
    } else if (l.t === ' ') {
      out.push({ left: l, right: l })
      i++
    } else {
      const dels: DiffLine[] = []
      const adds: DiffLine[] = []
      while (i < lines.length && lines[i].t === '-') dels.push(lines[i++])
      while (i < lines.length && lines[i].t === '+') adds.push(lines[i++])
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k], right: adds[k] })
    }
  }
  return out
}

function Split({ lines }: { lines: DiffLine[] }) {
  // One fill per side of a row: the change's tint, or the sunken well where that side has no line.
  const side = (l: DiffLine | undefined, which: 'a' | 'b'): ReactNode => {
    const fill = !l ? 'bg-sunken' : l.t === '-' ? 'diff-row-del' : l.t === '+' ? 'diff-row-add' : ''
    return (
      <>
        <td className={cn(NUM, 'pr-2', fill)}>{l ? (which === 'a' ? l.a : l.b) : ''}</td>
        <td className={cn('select-none align-top', fill, l?.t === '-' ? 'text-danger' : 'text-success')}>{l?.t === '-' ? '−' : l?.t === '+' ? '+' : ''}</td>
        <td className={cn('whitespace-pre-wrap break-all pr-3 align-top text-fg', fill, which === 'a' ? 'border-r border-border/60' : '')}>{l ? <Code s={l.s} /> : null}</td>
      </>
    )
  }
  return (
    <table className="w-full table-fixed border-collapse font-mono text-caption leading-[20px]">
      <colgroup>
        <col className="w-9" />
        <col className="w-4" />
        <col />
        <col className="w-9" />
        <col className="w-4" />
        <col />
      </colgroup>
      <tbody>
        {pairs(lines).map((p, i) =>
          p.hunk ? (
            <tr key={i} className="bg-surface text-tertiary">
              <td colSpan={6} className="px-4 py-0.5">
                {p.hunk}
              </td>
            </tr>
          ) : (
            <tr key={i}>
              {side(p.left?.t === '+' ? undefined : p.left, 'a')}
              {side(p.right?.t === '-' ? undefined : p.right, 'b')}
            </tr>
          )
        )}
      </tbody>
    </table>
  )
}

/** Just enough highlighting to read as code: keywords, strings, comments, numbers. */
export function Code({ s }: { s: string }) {
  const out: ReactNode[] = []
  const re =
    /(\/\/.*$|\/\*\*.*\*\/|#.*$|'[^']*'|"[^"]*"|`[^`]*`|\b(?:import|from|export|const|async|await|function|return|if|for|of|let|type|new|test|expect|CREATE|TABLE|PRIMARY|KEY|NOT|NULL)\b|\b\d[\d_]*\b)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    const cls =
      t.startsWith('//') || t.startsWith('/**') || t.startsWith('#')
        ? 'text-[var(--vy-syntax-comment)]'
        : t.startsWith("'") || t.startsWith('"') || t.startsWith('`')
          ? 'text-[var(--vy-syntax-string)]'
          : /^\d/.test(t)
            ? 'text-[var(--vy-syntax-number)]'
            : 'text-[var(--vy-syntax-keyword)]'
    out.push(
      <span key={m.index} className={cls}>
        {t}
      </span>
    )
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return <>{out}</>
}

/** How many changed lines a diff excerpt leaves out. */
export function hiddenLines(lines: DiffLine[], add: number, del: number): number {
  const shown = lines.filter((l) => l.t === '+' || l.t === '-').length
  return Math.max(0, add + del - shown)
}
