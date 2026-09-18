/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { UserPrompt } from '@renderer/features/chat/components/UserPrompt'
import {
  formatMcpToolInvocation,
  formatSkillInvocation
} from '@shared/slashCommands'
import type { UserItem } from '@renderer/features/chat/utils/transcriptRows'

describe('UserPrompt slash chips', () => {
  it('keeps submitted attachment rows out of the prompt bubble', () => {
    const item: UserItem = {
      kind: 'user',
      id: 'u-attachment',
      content: 'Review these files',
      messageIndex: 0,
      attachments: [
        { name: 'RELEASE-RUNDOWN.md', mime: 'text/markdown', chars: 120 },
        { name: 'LICENSE', mime: 'text/plain', chars: 40 }
      ]
    }

    render(<UserPrompt item={item} onImageClick={() => {}} />)

    expect(screen.queryByText('RELEASE-RUNDOWN.md')).toBeNull()
    expect(screen.queryByText('LICENSE')).toBeNull()
  })

  it('renders a skill chip and user request without the skill body', () => {
    const content = formatSkillInvocation(
      'code-review',
      '## Full skill body that must stay hidden',
      'Please review the auth module'
    )
    const item: UserItem = {
      kind: 'user',
      id: 'u1',
      content,
      messageIndex: 0
    }
    render(<UserPrompt item={item} onImageClick={() => {}} />)
    expect(screen.getByTitle('Skill: code-review')).toBeTruthy()
    expect(screen.getByText('code-review')).toBeTruthy()
    expect(screen.getByText(/Please review the auth module/)).toBeTruthy()
    expect(screen.queryByText(/Full skill body/)).toBeNull()
  })

  it('renders an MCP chip and user request without the tool description dump', () => {
    const content = formatMcpToolInvocation(
      'docs',
      'search',
      'Search the docs corpus',
      'find auth setup'
    )
    const item: UserItem = {
      kind: 'user',
      id: 'u2',
      content,
      messageIndex: 0
    }
    render(<UserPrompt item={item} onImageClick={() => {}} />)
    expect(screen.getByTitle('MCP: docs-search')).toBeTruthy()
    expect(screen.getByText('docs-search')).toBeTruthy()
    expect(screen.getByText(/find auth setup/)).toBeTruthy()
    expect(screen.queryByText(/Search the docs corpus/)).toBeNull()
  })

  it('does not enter edit when the click follows a text selection', () => {
    const onBeginEdit = vi.fn()
    const item: UserItem = {
      kind: 'user',
      id: 'u3',
      content: 'Select this prompt',
      messageIndex: 0
    }
    render(<UserPrompt item={item} onImageClick={() => {}} onBeginEdit={onBeginEdit} />)
    const bubble = screen.getByRole('button', { name: 'Edit user message' })
    const restore = window.getSelection
    window.getSelection = () =>
      ({ toString: () => 'Select this' }) as Selection
    fireEvent.click(bubble)
    expect(onBeginEdit).not.toHaveBeenCalled()
    window.getSelection = restore
    fireEvent.click(bubble)
    expect(onBeginEdit).toHaveBeenCalledTimes(1)
  })

  it('enters edit from Enter and Space on the prompt surface', () => {
    const onBeginEdit = vi.fn()
    const item: UserItem = {
      kind: 'user',
      id: 'u4',
      content: 'Keyboard-editable prompt',
      messageIndex: 0
    }
    render(<UserPrompt item={item} onImageClick={() => {}} onBeginEdit={onBeginEdit} />)

    const bubble = screen.getByRole('button', { name: 'Edit user message' })
    bubble.focus()
    fireEvent.keyDown(bubble, { key: 'Enter' })
    fireEvent.keyDown(bubble, { key: ' ' })

    expect(onBeginEdit).toHaveBeenCalledTimes(2)
  })

  it('returns focus to the prompt after inline editing closes', () => {
    const item: UserItem = {
      kind: 'user',
      id: 'u5',
      content: 'Restore focus after editing',
      messageIndex: 0
    }
    const { rerender } = render(
      <UserPrompt
        item={item}
        onImageClick={() => {}}
        onBeginEdit={() => {}}
        editComposer={<input aria-label="Inline edit" />}
      />
    )

    const prompt = screen.getByRole('button', { name: 'Edit user message' })
    prompt.focus()
    rerender(
      <UserPrompt
        item={item}
        onImageClick={() => {}}
        editing
        editComposer={<input aria-label="Inline edit" />}
      />
    )
    screen.getByRole('textbox', { name: 'Inline edit' }).focus()

    rerender(
      <UserPrompt
        item={item}
        onImageClick={() => {}}
        onBeginEdit={() => {}}
        editComposer={<input aria-label="Inline edit" />}
      />
    )

    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Edit user message' })
    )
  })

  it('does not enter edit when a read-only task checkbox is clicked', () => {
    const onBeginEdit = vi.fn()
    const item: UserItem = {
      kind: 'user',
      id: 'u-tasks',
      content:
        '- [ ] Wire SessionChatColumn file open so transcript path links open the Files dock\n- [x] Keep Think visible at the 360px min chat column after gutter inset',
      messageIndex: 0
    }
    render(<UserPrompt item={item} onImageClick={() => {}} onBeginEdit={onBeginEdit} />)
    const checkbox = document.querySelector('input[type="checkbox"]')
    expect(checkbox).toBeTruthy()
    fireEvent.click(checkbox!)
    expect(onBeginEdit).not.toHaveBeenCalled()
  })

  it('reveals edit and revert actions on hover-less (touch) input', () => {
    const item: UserItem = {
      kind: 'user',
      id: 'u-touch',
      content: 'Touch-reachable actions',
      messageIndex: 0
    }
    render(
      <UserPrompt
        item={item}
        onImageClick={() => {}}
        onBeginEdit={() => {}}
        onRevert={() => {}}
        canRevert
      />
    )
    // Both actions share one hover-revealed overlay, so the reveal rules live on
    // that group rather than being repeated on each button.
    const overlay = screen.getByRole('button', { name: 'Edit message' }).parentElement!
    expect(overlay).toBe(screen.getByRole('button', { name: 'Revert to before this prompt' }).parentElement)
    // Same fallback MessageFooter copy and sidebar row actions already carry.
    expect(overlay.className).toMatch(/\[@media\(hover:none\)\]:opacity-100/)
    expect(overlay.className).toMatch(/opacity-0/)
  })

  it('floats the actions over the prompt instead of reserving a right gutter', () => {
    const item: UserItem = {
      kind: 'user',
      id: 'u-gutter',
      content: 'Words that should run the full width of the column',
      messageIndex: 0
    }
    render(
      <UserPrompt
        item={item}
        onImageClick={() => {}}
        onBeginEdit={() => {}}
        onRevert={() => {}}
        canRevert
      />
    )
    // The actions are hover-only, so reserving padding for them narrowed every
    // prompt's text column against the rest of the transcript.
    const body = document.querySelector('[data-user-prompt] .markdown-body')!.parentElement!
    expect(body.className).not.toMatch(/(^|\s)pr-\d/)
    const overlay = screen.getByRole('button', { name: 'Edit message' }).parentElement!
    expect(overlay.className).toContain('absolute')
    // Page-colored fade masks whatever line the overlay covers while shown.
    expect(overlay.className).toContain('from-bg')
  })

  it('leaves no hover fill on the frameless prompt', () => {
    const item: UserItem = {
      kind: 'user',
      id: 'u-nofill',
      content: 'No tint band under the cursor',
      messageIndex: 0
    }
    render(<UserPrompt item={item} onImageClick={() => {}} onBeginEdit={() => {}} />)
    const prompt = document.querySelector('[data-user-prompt]')!
    expect(prompt.className).not.toContain('hover:bg-')
    expect(prompt.className).not.toContain('hover:border-')
    // A native tooltip over the whole message body is noise; the Edit button
    // carries the explanation instead.
    expect(prompt.getAttribute('title')).toBeNull()
  })
})
