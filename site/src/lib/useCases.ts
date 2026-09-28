import { getCollection, type CollectionEntry } from 'astro:content'

export type UseCase = CollectionEntry<'useCases'>

export const STAGES = ['First steps', 'Everyday work', 'Bigger jobs', 'Hands off'] as const

/** One line under each stage on the index: what that part of the path is for. */
export const STAGE_NOTE: Record<(typeof STAGES)[number], string> = {
  'First steps': 'Small jobs where you see every change and decide what stays.',
  'Everyday work': 'The jobs you will hand it most: small, checked, reviewed.',
  'Bigger jobs': 'Work that splits, runs on its own branch, and ends in a pull request.',
  'Hands off': 'Letting it run while you are away, and what keeps that safe.'
}

/** Every use case in path order. */
export async function allUseCases(): Promise<UseCase[]> {
  const list = await getCollection('useCases')
  return list.sort((a, b) => a.data.order - b.data.order)
}

export async function useCaseStages() {
  const list = await allUseCases()
  return STAGES.map((stage) => ({ stage, cases: list.filter((u) => u.data.stage === stage) })).filter((s) => s.cases.length)
}
