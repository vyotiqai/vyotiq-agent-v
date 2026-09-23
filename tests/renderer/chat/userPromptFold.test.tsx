/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UserPrompt } from '@renderer/features/chat/components/UserPrompt'
import { formatSkillInvocation } from '@shared/slashCommands'
import type { UserItem } from '@renderer/features/chat/utils/transcriptRows'

/** jsdom has no layout; report this content height for every element. */
function stubScrollHeight(px: number): void {
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(px)
}

function prompt(content: string): UserItem {
  return { kind: 'message', id: 'u1', role: 'user', content }
}

/** The prompt body is the bubble's first child; it carries the fold. */
function body(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-user-prompt] > div')!
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('UserPrompt fold', () => {
  it('folds a prompt past two lines behind Show more', () => {
    // Three 24px lines — clear of the half-line slack above the fold.
    stubScrollHeight(72)
    render(<UserPrompt item={prompt('a long prompt')} onImageClick={() => {}} />)
    expect(body().style.maxHeight).toBe('2lh')
    expect(body().classList.contains('mask-fade-bottom')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(body().style.maxHeight).toBe('')
    expect(body().classList.contains('mask-fade-bottom')).toBe(false)
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy()
  })

  it('leaves a prompt that only just spills past two lines open', () => {
    stubScrollHeight(56)
    render(<UserPrompt item={prompt('two lines and a sliver')} onImageClick={() => {}} />)
    expect(body().style.maxHeight).toBe('')
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('gives a slash chip its own line above the two folded ones', () => {
    stubScrollHeight(200)
    const content = formatSkillInvocation('code-review', 'skill body', 'Review the auth module')
    render(<UserPrompt item={prompt(content)} onImageClick={() => {}} />)
    expect(body().style.maxHeight).toBe('3lh')
  })
})
