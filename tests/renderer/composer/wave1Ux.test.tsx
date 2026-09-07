/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { useComposerDraft } from '@renderer/features/chat/components/composer/useComposerDraft'
import { filesFromDataTransfer } from '@renderer/features/chat/components/composer/dataTransferFiles'
import { lastUserMessageIndex } from '@renderer/features/chat/hooks/composerShared'
import type { ChatMessage } from '@shared/ipc'

function ArrowUpHarness({
  draft,
  onEditLastUserMessage,
  caret = 0
}: {
  draft: string
  onEditLastUserMessage: () => boolean
  caret?: number
}) {
  const { onKeyDown } = useComposerDraft({
    draft,
    onDraftChange: () => {},
    images: [],
    setImages: () => {},
    setImageError: () => {},
    files: [],
    setFiles: () => {},
    setFileError: () => {},
    onSend: async () => true,
    onEditLastUserMessage,
    getCaretStart: () => caret
  })
  return <textarea aria-label="Draft" onKeyDown={onKeyDown} />
}

describe('filesFromDataTransfer', () => {
  it('reads FileList first, then item files', () => {
    const file = new File(['a'], 'a.txt', { type: 'text/plain' })
    expect(
      filesFromDataTransfer({
        files: [file] as unknown as FileList,
        items: [] as unknown as DataTransferItemList,
        types: ['Files']
      } as DataTransfer)
    ).toEqual([file])

    const viaItem = new File(['b'], 'b.png', { type: 'image/png' })
    expect(
      filesFromDataTransfer({
        files: [] as unknown as FileList,
        items: [{ kind: 'file', getAsFile: () => viaItem }] as unknown as DataTransferItemList,
        types: ['Files']
      } as DataTransfer)
    ).toEqual([viaItem])
  })
})

describe('lastUserMessageIndex', () => {
  it('returns the last user message index', () => {
    const messages = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'two' }
    ] as ChatMessage[]
    expect(lastUserMessageIndex(messages)).toBe(2)
    expect(lastUserMessageIndex([{ role: 'assistant', content: 'x' }] as ChatMessage[])).toBeNull()
  })
})

describe('useComposerDraft ArrowUp', () => {
  it('edits last user message when the draft is empty', () => {
    const onEditLastUserMessage = vi.fn(() => true)
    const { getByLabelText } = render(
      <ArrowUpHarness draft="" onEditLastUserMessage={onEditLastUserMessage} />
    )
    fireEvent.keyDown(getByLabelText('Draft'), { key: 'ArrowUp' })
    expect(onEditLastUserMessage).toHaveBeenCalledTimes(1)
  })

  it('does not edit when caret is not at the start of a non-empty draft', () => {
    const onEditLastUserMessage = vi.fn(() => true)
    const { getByLabelText } = render(
      <ArrowUpHarness draft="hello" caret={3} onEditLastUserMessage={onEditLastUserMessage} />
    )
    fireEvent.keyDown(getByLabelText('Draft'), { key: 'ArrowUp' })
    expect(onEditLastUserMessage).not.toHaveBeenCalled()
  })
})
