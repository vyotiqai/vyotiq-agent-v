import type { ReactNode } from 'react'

/** Slug for plan outline / heading scroll targets. */
export function slugifyHeading(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
  return s || 'section'
}

/** Collision-aware id allocator (first occurrence keeps base slug). */
export function allocateHeadingId(text: string, used: Map<string, number>): string {
  const base = slugifyHeading(text)
  const n = used.get(base) ?? 0
  used.set(base, n + 1)
  return n === 0 ? base : `${base}-${n}`
}

export function extractHeadingText(children: ReactNode): string {
  if (children == null || typeof children === 'boolean') return ''
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(extractHeadingText).join('')
  if (typeof children === 'object' && children !== null && 'props' in children) {
    const el = children as { props?: { children?: ReactNode } }
    return extractHeadingText(el.props?.children)
  }
  return ''
}
