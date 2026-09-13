/** Snapshot interactive-element refs for browser_click / browser_type. */

export type BrowserElementRef = {
  id: string
  selector: string
  tag: string
  role: string
  name: string
}

const REF_RE = /^@?(e\d+)$/i

/** Parse `@e12` / `e12` snapshot refs; otherwise treat as a CSS selector. */
export function parseBrowserTarget(raw: string): { kind: 'ref'; id: string } | { kind: 'css'; selector: string } {
  const trimmed = raw.trim()
  const m = REF_RE.exec(trimmed)
  if (m) return { kind: 'ref', id: m[1]!.toLowerCase() }
  return { kind: 'css', selector: trimmed }
}

function formatOneInteractiveRef(r: BrowserElementRef): string {
  const name = r.name ? JSON.stringify(r.name) : '""'
  const role = r.role || r.tag.toLowerCase()
  return `- @${r.id} role=${JSON.stringify(role)} name=${name} css=${JSON.stringify(r.selector)}`
}

export function formatInteractiveRefs(refs: BrowserElementRef[]): string {
  if (refs.length === 0) return '(no interactive elements found)'
  return refs.map(formatOneInteractiveRef).join('\n')
}

/**
 * Fit as many interactive ref lines as possible under `maxChars`.
 * Always includes at least one line when refs exist (may slightly exceed budget).
 */
export function formatInteractiveRefsWithinBudget(
  refs: BrowserElementRef[],
  maxChars: number
): { text: string; included: number; omitted: number } {
  if (refs.length === 0) {
    return { text: '(no interactive elements found)', included: 0, omitted: 0 }
  }
  const budget = Math.max(32, maxChars)
  const lines: string[] = []
  let used = 0
  for (const ref of refs) {
    const line = formatOneInteractiveRef(ref)
    const add = (lines.length > 0 ? 1 : 0) + line.length
    if (lines.length > 0 && used + add > budget) break
    lines.push(line)
    used += add
  }
  const omitted = refs.length - lines.length
  let text = lines.join('\n')
  if (omitted > 0) {
    const note = `\n… (${omitted} more interactive ${omitted === 1 ? 'ref' : 'refs'} omitted)`
    if (text.length + note.length <= budget + 80) text += note
  }
  return { text, included: lines.length, omitted }
}
