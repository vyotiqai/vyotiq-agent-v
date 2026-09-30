import { describe, expect, it } from 'vitest'
import {
  MENTION_END,
  MENTION_START,
  decodeMentionPayload,
  extractMentions,
  mentionLabel,
  mentionMarker,
  type ComposerMention
} from '@renderer/features/chat/components/composer/mentionModel'
import { resolveComposerMentions } from '@renderer/features/chat/components/composer/resolveMentions'
import { appendMentionToDraft } from '@renderer/features/chat/components/composer/composerMentionEvent'
import {
  clampPickText,
  pickedElementContextBlock,
  pickedElementLabel,
  sanitizePickedElement
} from '@shared/browserPick'
import { BROWSER_PICK_LIMITS, type BrowserPickedElement } from '@shared/ipc'

const element: BrowserPickedElement = {
  selector: '[data-testid="sign-in"]',
  tag: 'button',
  role: 'button',
  name: 'Sign in',
  text: 'Sign in',
  url: 'https://example.test/login?next=%2F',
  bounds: { x: 12, y: 40, width: 96, height: 32 },
  ref: 'e7'
}
const mention: ComposerMention = { kind: 'element', element }

describe('picked element chips', () => {
  it('round-trips through a draft marker and names the chip by tag and name', () => {
    const marker = mentionMarker(mention)
    expect(decodeMentionPayload(marker.slice(MENTION_START.length, -MENTION_END.length))).toEqual(mention)
    expect(extractMentions(`look at ${marker} please`)).toEqual([mention])
    expect(mentionLabel(mention)).toBe('<button> "Sign in"')
    expect(pickedElementLabel({ ...element, name: '', text: '' })).toBe('<button>')
    expect(pickedElementLabel({ ...element, name: 'x'.repeat(60) })).toHaveLength('<button> ""'.length + 28)
  })

  it('re-checks an edited marker instead of trusting it', () => {
    const bad = encodeURIComponent(JSON.stringify({ ...element, tag: 'img onerror=x' }))
    expect(decodeMentionPayload(`element:${bad}`)).toBeNull()
    expect(decodeMentionPayload('element:%7Bnot json')).toBeNull()
  })

  it('clamps page strings and strips control and marker characters', () => {
    const el = sanitizePickedElement({
      ...element,
      name: `a${MENTION_START}b${MENTION_END}${String.fromCharCode(7)}c\n\nd`,
      text: 'y'.repeat(5000),
      selector: 's'.repeat(BROWSER_PICK_LIMITS.selector + 1),
      ref: 'e1; drop'
    })
    expect(el?.name).toBe('a b c d')
    expect(el?.text).toHaveLength(BROWSER_PICK_LIMITS.text)
    expect(el?.text.endsWith('…')).toBe(true)
    // Half a selector matches something else: an over-long one becomes the tag.
    expect(el?.selector).toBe('button')
    expect(el?.ref).toBeUndefined()
    expect(clampPickText(42, 10)).toBe('')
  })

  it('appends one chip per element to the end of the draft', () => {
    const once = appendMentionToDraft('fix this', mention)
    expect(once).toBe(`fix this ${mentionMarker(mention)} `)
    expect(appendMentionToDraft(once, mention)).toBe(once)
    expect(appendMentionToDraft('', mention)).toBe(`${mentionMarker(mention)} `)
  })

  it('sends the element to the agent as a referenced block, page values quoted', async () => {
    const res = await resolveComposerMentions({
      workspacePath: null,
      draft: `Why is this grey? ${mentionMarker(mention)}`,
      existingFiles: []
    })
    expect(res.error).toBeNull()
    expect(res.text.startsWith('Why is this grey?')).toBe(true)
    expect(res.text).toContain(pickedElementContextBlock(element))
    expect(res.text).toContain('Selector: "[data-testid=\\"sign-in\\"]"')
    expect(res.text).toContain('Snapshot ref: @e7')
    expect(res.text).toContain('Page: "https://example.test/login?next=%2F"')
  })
})
