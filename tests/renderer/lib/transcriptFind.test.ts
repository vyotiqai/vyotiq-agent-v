/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { isChangesOrPrDockClaimingFind } from '@renderer/lib/chat/transcriptFind'

describe('isChangesOrPrDockClaimingFind', () => {
  it('is true only for a visible changes or PR dock', () => {
    expect(isChangesOrPrDockClaimingFind()).toBe(false)
    const panel = document.createElement('div')
    panel.id = 'dock-panel-changes'
    document.body.appendChild(panel)
    expect(isChangesOrPrDockClaimingFind()).toBe(true)
    panel.setAttribute('inert', '')
    expect(isChangesOrPrDockClaimingFind()).toBe(false)
    panel.removeAttribute('inert')
    panel.classList.add('hidden')
    expect(isChangesOrPrDockClaimingFind()).toBe(false)
    panel.remove()
  })
})
