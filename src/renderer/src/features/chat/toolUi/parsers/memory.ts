import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'
import { splitLines } from './common'

/**
 * `index.md coverage: <indexed>/<onDisk> notes (drift)` — how much of the
 * notes/ directory the injected index actually points at. The producer emits
 * the drift clause only when the two disagree, so `drift` is '' when full.
 */
export type MemoryCoverage = {
  indexed: number
  total: number
  drift: string
}

export type MemoryListParsed = {
  /** Note filenames only — the producer's bullet list, verbatim. */
  notes: string[]
  coverage: MemoryCoverage | null
  hasState: boolean
}

export type MemoryReadParsed = {
  path: string
  lines: string[]
}

export type MemoryWriteParsed = {
  path: string
  preview: string
  charCount: number
}

const COVERAGE_RE = /index\.md coverage:\s*(\d+)\/(\d+)\s*notes\s*(?:\(([^)]*)\))?/i

/**
 * Parse the exact text `toolMemoryList` emits (src/main/agent/tools/memory.ts):
 *
 *   ## notes/
 *   - arch.md
 *   - prefs.md
 *
 *   index.md coverage: 2/2 notes — full
 *   state.md: present
 *
 *   index.md is pre-injected into the system prompt (memory_read index.md …)
 *
 * The notes block ends at the first blank line, which is what separates it from
 * the coverage / state / trailer lines below it. There is no index excerpt to
 * read: the producer stopped emitting one because index.md is already injected
 * into the model prompt, so a section for it could only ever render as empty.
 */
export function parseMemoryListData(tool: UiToolRow): MemoryListParsed {
  const content = tool.content ?? ''
  const notesBlock = content.match(/## notes\/[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*\r?\n|$)/i)
  const notes =
    notesBlock?.[1]
      ?.split(/\r?\n/)
      .map((line) => line.replace(/^-\s*/, '').trim())
      .filter((line) => line && line !== '(none)') ?? []
  const coverageMatch = content.match(COVERAGE_RE)
  const coverage: MemoryCoverage | null = coverageMatch
    ? {
        indexed: Number(coverageMatch[1]),
        total: Number(coverageMatch[2]),
        drift: (coverageMatch[3] ?? '').trim()
      }
    : null
  const hasState = /state\.md:\s*present/i.test(content)
  return { notes, coverage, hasState }
}

export function parseMemoryReadData(tool: UiToolRow): MemoryReadParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const path = typeof args?.path === 'string' ? args.path : tool.summary?.trim() || ''
  const lines = splitLines(tool.content ?? '')
  return { path, lines }
}

export function parseMemoryWriteData(tool: UiToolRow): MemoryWriteParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const path = typeof args?.path === 'string' ? args.path : tool.summary?.trim() || ''
  const preview =
    typeof args?.contents === 'string' ? args.contents : (tool.content ?? '').replace(/^Wrote memory\//, '')
  return { path, preview, charCount: preview.length }
}
