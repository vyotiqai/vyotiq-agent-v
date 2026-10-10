import type { ViewBlock, ViewSpec } from '@shared/viewSpec'
import { viewBlockLines } from '@shared/viewText'

/*
  A view as text you can paste: Markdown, with each live block as what it
  last read rather than the name of its source. Buttons and forms are left
  out; they do something here and mean nothing pasted.
*/

/** A live block's last read, by its key in the view (`blockKey`). */
export type LiveReads = ReadonlyMap<string, ViewBlock>

/** The view as Markdown; `keys` names each block as the view drew it. */
export function viewMarkdown(spec: ViewSpec, reads: LiveReads, keys: readonly string[]): string {
  const out = [`### ${spec.title}`]
  if (spec.subtitle) out.push(spec.subtitle)
  spec.blocks.forEach((b, i) => {
    const read = b.type === 'live' ? reads.get(keys[i] ?? '') : b
    const lines = read ? viewBlockLines(read) : b.type === 'live' ? [`_${b.title ?? b.source}: not read_`] : []
    if (b.type === 'live' && read && b.title && (read.type === 'stats' || read.type === 'note')) lines.unshift(`**${b.title}**`)
    if (lines.length > 0) out.push('', ...lines)
  })
  return out.join('\n')
}

/** The view as its data: the spec, with what each live block read beside its source. */
export function viewData(spec: ViewSpec, reads: LiveReads, keys: readonly string[]): string {
  const blocks = spec.blocks.map((b, i) => {
    if (b.type !== 'live') return b
    const read = reads.get(keys[i] ?? '')
    return read ? { ...b, read } : b
  })
  return JSON.stringify({ ...spec, blocks }, null, 2)
}
