import {
  PROMPT_STRUCTURE_MAX_INPUT_CHARS,
  STRUCTURED_FROM_MAX_CHARS,
  TASK_DRAFT_CHECK_CHARS_MAX,
  TASK_DRAFT_CHECKS_MAX,
  type PromptStructureMention
} from '@shared/ipc'
import { normalizeCheckText } from '@shared/doneWhenChecks'
import {
  composerDocumentPlainText,
  findSlashChipSubmit,
  mentionLabel,
  mentionMarker,
  parseComposerDocument
} from './mentionModel'

/**
 * The draft as Structure sends it and takes it back. Chips can't go to a model
 * as they are (their markers are private bytes), so each one is a token —
 * `[[@1]]` — with a line saying what it is, and the brief's tokens become the
 * same chips again.
 */

/** Fewer words than this is "yes", "continue", "run it": nothing to structure. */
export const STRUCTURE_MIN_WORDS = 3

export type StructureEligibility = { ok: true } | { ok: false; reason: string }

export function structureEligibility(draft: string): StructureEligibility {
  if (findSlashChipSubmit(draft)) return { ok: false, reason: 'A slash command runs as it is' }
  const plain = composerDocumentPlainText(draft).trim()
  if (plain.length > PROMPT_STRUCTURE_MAX_INPUT_CHARS) return { ok: false, reason: 'Too long to structure' }
  const words = plain.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  if (words < STRUCTURE_MIN_WORDS) return { ok: false, reason: 'Write what you want done first' }
  return { ok: true }
}

export type StructureInput = {
  text: string
  mentions: PromptStructureMention[]
  /** Token → the chip's marker, to put the chips back. */
  markers: Map<string, string>
}

const MAX_TOKENS = 40

export function draftToStructureInput(draft: string): StructureInput {
  const mentions: PromptStructureMention[] = []
  const markers = new Map<string, string>()
  const parts: string[] = []
  for (const seg of parseComposerDocument(draft)) {
    if (seg.type === 'text') {
      // A literal token typed by the person must not pose as a chip.
      parts.push(seg.value.replace(/\[\[@(\d{1,2})\]\]/g, '[[ @$1]]'))
      continue
    }
    const mention = seg.mention
    if (mention.kind === 'slash' || mentions.length >= MAX_TOKENS) {
      parts.push(composerDocumentPlainText(mentionMarker(mention)))
      continue
    }
    const token = `[[@${mentions.length + 1}]]`
    const path = 'path' in mention && typeof mention.path === 'string' ? mention.path : undefined
    mentions.push({ token, kind: mention.kind, label: mentionLabel(mention).slice(0, 300), ...(path ? { path } : {}) })
    markers.set(token, mentionMarker(mention))
    parts.push(token)
  }
  return { text: parts.join('').trim(), mentions, markers }
}

/** The brief as a draft: tokens back to chips, any token it should not have dropped. */
export function briefToDraft(brief: string, markers: ReadonlyMap<string, string>): string {
  return brief.replace(/\[\[@\d{1,2}\]\]/g, (token) => markers.get(token) ?? '')
}

export type DoneWhenMove = {
  /** The brief without the bullets that moved; whatever else the section held stays. */
  draft: string
  /** The checks after the move: the ones already there, then the new ones. */
  checks: string[]
  /** The new checks, in order — what Undo takes back out. */
  added: string[]
}

const DONE_WHEN_HEADING = /^#{1,6}\s+done when\b/i
const ANY_HEADING = /^#{1,6}\s/
const TOP_ITEM = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/
const NESTED_ITEM = /^\s+(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/

function trimBlankEdges(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start]!.trim()) start += 1
  while (end > start && !lines[end - 1]!.trim()) end -= 1
  return lines.slice(start, end)
}

/**
 * The brief's `## Done when` bullets as New task checks, parsed as the plan's
 * are (`- x`, `1. x`, `- [ ] x`; nested items fold into their parent). A
 * bullet that restates a check already there is dropped from the brief, not
 * added twice; bullets past the checks' limit stay in the brief. Null when
 * nothing would be added.
 */
export function moveDoneWhenToChecks(draft: string, existing: readonly string[]): DoneWhenMove | null {
  const lines = draft.split(/\r?\n/)
  const heading = lines.findIndex((line) => DONE_WHEN_HEADING.test(line))
  if (heading < 0) return null
  let end = lines.length
  for (let i = heading + 1; i < lines.length; i++) {
    if (ANY_HEADING.test(lines[i]!)) {
      end = i
      break
    }
  }

  // Each item with the lines it spans: its nested items and indented continuation.
  const items: { lines: number[]; text: string }[] = []
  for (let i = heading + 1; i < end; i++) {
    const line = lines[i]!
    const top = TOP_ITEM.exec(line)
    if (top) {
      items.push({ lines: [i], text: top[1]!.trim() })
      continue
    }
    const last = items[items.length - 1]
    if (!last || !/^\s+\S/.test(line) || last.lines[last.lines.length - 1] !== i - 1) continue
    const nested = NESTED_ITEM.exec(line)
    last.text += nested ? ` — ${nested[1]!.trim()}` : ` ${line.trim()}`
    last.lines.push(i)
  }

  const checks = [...existing]
  const seen = new Set(existing.map(normalizeCheckText))
  const added: string[] = []
  const moved = new Set<number>()
  for (const item of items) {
    // Chips become their names: a check is plain text.
    const text = composerDocumentPlainText(item.text).replace(/\s+/g, ' ').trim().slice(0, TASK_DRAFT_CHECK_CHARS_MAX).trim()
    const key = normalizeCheckText(text)
    if (key && !seen.has(key)) {
      if (checks.length >= TASK_DRAFT_CHECKS_MAX) continue
      seen.add(key)
      checks.push(text)
      added.push(text)
    }
    for (const i of item.lines) moved.add(i)
  }
  if (added.length === 0) return null

  const rest = trimBlankEdges(lines.slice(heading + 1, end).filter((_, offset) => !moved.has(heading + 1 + offset)))
  const section = rest.length > 0 ? [lines[heading]!, ...rest] : []
  const parts = [trimBlankEdges(lines.slice(0, heading)), section, trimBlankEdges(lines.slice(end))].filter(
    (part) => part.length > 0
  )
  return { draft: parts.map((part) => part.join('\n')).join('\n\n'), checks, added }
}

/** What the person wrote, as the record keeps it: chips as their names. */
export function structuredFromText(original: string): string {
  return composerDocumentPlainText(original).trim().slice(0, STRUCTURED_FROM_MAX_CHARS)
}
