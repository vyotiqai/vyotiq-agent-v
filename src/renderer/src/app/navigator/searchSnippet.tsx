import type { ReactNode } from 'react'

/** Where a search found a task, when it wasn't the title: the matching line. */
export type RowSnippet = {
  text: string
  start: number
  length: number
  where: 'title' | 'you' | 'agent' | 'tool'
}

/** Who said the matching line. */
export const WHERE_WORDS: Record<RowSnippet['where'], string> = { title: '', you: 'You', agent: 'Agent', tool: 'Tool' }

/** The snippet with its match marked; finds the query again if the offsets drifted. */
export function highlightMatch(text: string, start: number, length: number, query: string): ReactNode {
  let at = start
  if (text.slice(at, at + length).toLowerCase() !== query.toLowerCase()) at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0 || length === 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-accent-soft px-px text-fg-strong">{text.slice(at, at + length)}</mark>
      {text.slice(at + length)}
    </>
  )
}
