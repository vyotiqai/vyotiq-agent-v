import { getCollection, type CollectionEntry } from 'astro:content'

export type Doc = CollectionEntry<'docs'>

export const GROUPS = ['Start', 'Tasks', 'Review and ship', 'Extend', 'Reference'] as const

/** All docs in reading order: by group, then by `order`. */
export async function allDocs(): Promise<Doc[]> {
  const docs = await getCollection('docs')
  return docs.sort(
    (a, b) => GROUPS.indexOf(a.data.group) - GROUPS.indexOf(b.data.group) || a.data.order - b.data.order
  )
}

export async function docGroups() {
  const docs = await allDocs()
  return GROUPS.map((group) => ({ group, docs: docs.filter((d) => d.data.group === group) })).filter((g) => g.docs.length)
}
