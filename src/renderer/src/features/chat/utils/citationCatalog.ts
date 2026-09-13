import {
  collectCitationCatalog,
  type CitationCatalogEntry,
  type CiteToolEvidence
} from '@shared/utils/inlineCitations'
import type { ToolItem, TranscriptRow } from './transcriptRows'

function evidenceFromToolItem(item: ToolItem): CiteToolEvidence {
  return {
    name: item.tool.name,
    argsPreview: item.tool.argsPreview,
    content: item.tool.content,
    status: item.tool.status
  }
}

/** Catalog of citable file/web sources keyed by transcript turn. */
export type CitationCatalogCacheEntry = {
  evidence: CiteToolEvidence[]
  catalog: CitationCatalogEntry[]
}

/** Tools whose content feeds the catalog (mirrors collectCitationCatalog). */
const CONTENT_CITING_TOOLS = new Set([
  'grep',
  'search',
  'codebase_search',
  'browser_search',
  'browser_navigate',
  'browser_snapshot'
])

function evidenceEquivalent(a: CiteToolEvidence, b: CiteToolEvidence): boolean {
  if (a.name !== b.name || a.status !== b.status) return false
  if (a.name === 'read') return a.argsPreview === b.argsPreview
  if (CONTENT_CITING_TOOLS.has(a.name)) {
    return a.argsPreview === b.argsPreview && a.content === b.content
  }
  return true
}

function sameEvidence(a: readonly CiteToolEvidence[], b: readonly CiteToolEvidence[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!evidenceEquivalent(a[i]!, b[i]!)) return false
  }
  return true
}

/**
 * Reuse per-turn catalog ARRAYS when the citable evidence for a turn is
 * unchanged, so historical rows keep their `citationCatalog` prop identity and
 * memoized transcript rows can skip re-rendering every stream frame.
 */
export function collectTurnCitationCatalogs(
  rows: readonly TranscriptRow[],
  previous?: ReadonlyMap<number, CitationCatalogCacheEntry>
): {
  catalogs: Map<number, CitationCatalogEntry[]>
  cache: Map<number, CitationCatalogCacheEntry>
} {
  const tools = new Map<number, CiteToolEvidence[]>()
  for (const row of rows) {
    if (row.kind === 'activity') {
      const list = tools.get(row.turnIndex) ?? []
      for (const item of row.tools) list.push(evidenceFromToolItem(item))
      tools.set(row.turnIndex, list)
      continue
    }
    if (row.kind === 'card') {
      const list = tools.get(row.turnIndex) ?? []
      list.push(evidenceFromToolItem(row.item))
      tools.set(row.turnIndex, list)
    }
  }
  const catalogs = new Map<number, CitationCatalogEntry[]>()
  const cache = new Map<number, CitationCatalogCacheEntry>()
  for (const [turn, evidence] of tools) {
    const hit = previous?.get(turn)
    if (hit && sameEvidence(hit.evidence, evidence)) {
      catalogs.set(turn, hit.catalog)
      cache.set(turn, hit)
      continue
    }
    const catalog = collectCitationCatalog(evidence)
    catalogs.set(turn, catalog)
    cache.set(turn, { evidence, catalog })
  }
  return { catalogs, cache }
}
