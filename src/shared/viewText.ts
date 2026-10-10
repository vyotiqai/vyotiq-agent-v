import type { ViewBlock } from './viewSpec'

/*
  A view block as Markdown lines: what Copy puts on the clipboard, and what
  show_view tells the model a live block read. Buttons and forms have no
  text of their own; a live block is described by what it read.
*/

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const CHECK_WORD = { pass: 'passed', fail: 'failed', running: 'running', pending: 'not run yet' } as const

/** One block as Markdown lines; none for a button row, a form or an unread live block. */
export function viewBlockLines(b: ViewBlock): string[] {
  switch (b.type) {
    case 'stats':
      return b.items.map((s) => `- ${s.label}: **${s.value}**${s.hint ? ` (${s.hint})` : ''}`)
    case 'rows': {
      const head = b.title ? [`**${b.title}** (${Math.max(b.total ?? 0, b.items.length)})`] : []
      const rows = b.items.map((r) => {
        const parts = [`${r.lead ?? ''}${r.title}`]
        if (r.meta) parts.push(r.meta)
        if (r.diff) parts.push(`+${r.diff.add} −${r.diff.del}`)
        if (r.value) parts.push(r.value)
        if (r.state) parts.push(r.state)
        return `- ${parts.join(' · ')}`
      })
      return [...head, ...rows, ...(b.more ? [`- ${b.more}`] : [])]
    }
    case 'table': {
      const head = b.title ? [`**${b.title}**`, ''] : []
      return [
        ...head,
        `| ${b.columns.map((c) => cell(c.label)).join(' | ')} |`,
        `| ${b.columns.map((c) => (c.align === 'end' ? '---:' : '---')).join(' | ')} |`,
        ...b.rows.map((r) => `| ${b.columns.map((c) => cell(r.cells[c.id] ?? '')).join(' | ')} |`)
      ]
    }
    case 'chart': {
      const s = b.spec as { title?: string; labels?: readonly string[]; values?: readonly (number | null)[] }
      const values = s.values ?? []
      return [...(s.title ? [`**${s.title}**`] : []), ...values.map((v, i) => `- ${s.labels?.[i] ?? i + 1}: ${v ?? '—'}`)]
    }
    case 'checks': {
      const met = b.passed ?? b.items.filter((c) => c.state === 'pass').length
      return [
        `**${b.title ?? 'Checks'}** (${met}/${Math.max(b.total ?? 0, b.items.length)})`,
        ...b.items.map((c) => `- [${c.state === 'pass' ? 'x' : ' '}] ${c.label} — ${CHECK_WORD[c.state]}`),
        ...(b.more ? [`- ${b.more}`] : [])
      ]
    }
    case 'note':
      return [b.text]
    case 'actions':
    case 'form':
    case 'live':
      return []
  }
}
