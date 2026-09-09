import { getCollection, type CollectionEntry } from 'astro:content'
import type { APIContext, APIRoute } from 'astro'

export async function getStaticPaths() {
  const docs = await getCollection('docs')
  // The filename's `.md` is the literal route suffix — the slug is the plain doc id,
  // so /docs/<section>/<doc> serves raw markdown at /docs/<section>/<doc>.md.
  return docs.map((entry) => ({
    params: { slug: entry.id },
    props: { entry }
  }))
}

interface Props {
  entry: CollectionEntry<'docs'>
}

export const GET: APIRoute = async (context: APIContext) => {
  const { entry } = context.props as Props
  return new Response(entry.body ?? '', {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' }
  })
}
