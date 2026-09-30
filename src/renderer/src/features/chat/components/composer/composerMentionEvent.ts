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
