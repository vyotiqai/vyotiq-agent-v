import { mentionMarker, type ComposerMention } from './mentionModel'

/**
 * A surface outside the composer (the Browser tab's element picker) adding a
 * chip to the composer of the same task. The composer on that workspace and
 * run takes it; an inline edit composer never does.
 */
export const ADD_COMPOSER_MENTION_EVENT = 'vyotiq:composer-add-mention'

export type AddComposerMentionDetail = {
  workspacePath: string | null
  runId: string | null
  mention: ComposerMention
}

export function addMentionToComposer(detail: AddComposerMentionDetail): void {
  window.dispatchEvent(
    new CustomEvent<AddComposerMentionDetail>(ADD_COMPOSER_MENTION_EVENT, { detail })
  )
}

/**
 * The draft with the chip at its end, a space either side. Picking the same
 * thing twice leaves one chip.
 */
export function appendMentionToDraft(draft: string, mention: ComposerMention): string {
  const marker = mentionMarker(mention)
  if (draft.includes(marker)) return draft
  const gap = draft && !/\s$/.test(draft) ? ' ' : ''
  return `${draft}${gap}${marker} `
}

export const COMPOSER_DRAFT_EVENT = 'vyotiq:composer-draft'

export type ComposerDraftDetail = {
  workspacePath: string | null
  runId: string | null
  text: string
}

/**
 * An instruction written elsewhere (Review's "Ask it to cover this") put into
 * the same task's box to read and edit before it goes. True when a composer
 * took it; false when none could, so the caller can fall back.
 */
export function draftIntoComposer(detail: ComposerDraftDetail): boolean {
  const event = new CustomEvent<ComposerDraftDetail>(COMPOSER_DRAFT_EVENT, { detail, cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

/** The draft with the instruction after it, a blank line between. */
export function appendInstructionToDraft(draft: string, text: string): string {
  const kept = draft.trimEnd()
  return kept ? `${kept}\n\n${text}` : text
}
