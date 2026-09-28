import { defineCollection } from 'astro:content'
import { z } from 'astro/zod'
import { glob } from 'astro/loaders'

/** Docs pages: one markdown file each, ordered by `order` within their `group`. */
const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    group: z.enum(['Start', 'Tasks', 'Review and ship', 'Extend', 'Reference']),
    order: z.number()
  })
})

/**
 * Use cases: a path through Agent V in the order people learn it. Each is one
 * job, with a brief you can paste. They link to the docs for the details
 * rather than repeating them.
 */
const useCases = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/use-cases' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    stage: z.enum(['First steps', 'Everyday work', 'Bigger jobs', 'Hands off']),
    /** Place in the whole path, from 1. */
    order: z.number(),
    /** What it teaches, as the app names those things. */
    teaches: z.array(z.string()).min(1),
    mode: z.enum(['Agent', 'Ask']),
    /** A brief for the New task page, or a slash command. */
    kind: z.enum(['brief', 'command']).default('brief'),
    brief: z.string(),
    checks: z.array(z.string()).default([]),
    /** Docs pages with the details, as `/docs/...` paths. */
    docs: z.array(z.object({ label: z.string(), href: z.string().startsWith('/docs/') })).min(1)
  })
})

export const collections = { docs, useCases }
